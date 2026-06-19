// Low-level audio engine. Two "decks" (A/B), each an <audio> element routed
// through its own Web Audio gain node into a shared master gain. This enables:
//   - real volume control (master gain, independent of element.volume)
//   - per-track ReplayGain normalization (deck gain)
//   - crossfade (ramp one deck down while the other ramps up)
//   - gapless-ish playback (preload the next track on the idle deck)
//
// The Web Audio graph is created lazily on first play to satisfy autoplay
// policies (it must follow a user gesture).

export interface DeckTrack {
  url: string;
  replayGainDb: number; // 0 when normalization is off
  peak: number; // 1 when unknown; used to avoid clipping
}

interface Deck {
  el: HTMLAudioElement;
  source?: MediaElementAudioSourceNode;
  gain?: GainNode;
  url: string | null;
}

export interface EngineCallbacks {
  onProgress: (time: number, duration: number) => void;
  onEnded: () => void;
  onPlayingChange: (playing: boolean) => void;
  // Fired once when crossfade begins, so the store can advance queue state.
  onCrossfadeStart: () => void;
}

function gainFromDb(db: number, peak: number): number {
  if (!db) return 1;
  let linear = Math.pow(10, db / 20);
  // Keep peak below clipping when peak data is available.
  if (peak > 0 && linear * peak > 1) linear = 1 / peak;
  return linear;
}

export class AudioEngine {
  private ctx?: AudioContext;
  private master?: GainNode;
  private decks: [Deck, Deck];
  private active = 0; // index into decks
  private volume = 0.8;
  private muted = false;
  private crossfadeSeconds = 0;
  private crossfading = false;
  private raf = 0;
  private cb: EngineCallbacks;

  constructor(cb: EngineCallbacks) {
    this.cb = cb;
    const mk = (): Deck => {
      const el = new Audio();
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      return { el, url: null };
    };
    this.decks = [mk(), mk()];

    for (const deck of this.decks) {
      deck.el.addEventListener("ended", () => this.handleEnded(deck));
    }
  }

  private ensureGraph(): void {
    if (this.ctx) return;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.ctx.destination);
    for (const deck of this.decks) {
      deck.source = this.ctx.createMediaElementSource(deck.el);
      deck.gain = this.ctx.createGain();
      deck.gain.gain.value = 1;
      deck.source.connect(deck.gain);
      deck.gain.connect(this.master);
    }
  }

  private activeDeck(): Deck {
    return this.decks[this.active];
  }
  private idleDeck(): Deck {
    return this.decks[this.active ^ 1];
  }

  setCrossfade(seconds: number): void {
    this.crossfadeSeconds = Math.max(0, Math.min(12, seconds));
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && !this.muted) {
      this.master.gain.value = this.volume;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  // Preload a track on the idle deck so the next play (or crossfade) is instant.
  prepareNext(track: DeckTrack | null): void {
    const idle = this.idleDeck();
    if (!track) {
      idle.url = null;
      return;
    }
    if (idle.url === track.url) return;
    idle.el.src = track.url;
    idle.url = track.url;
    idle.el.load();
  }

  async play(track: DeckTrack): Promise<void> {
    this.ensureGraph();
    if (this.ctx?.state === "suspended") await this.ctx.resume();
    this.crossfading = false;

    // Reuse a preloaded idle deck if it already holds this track (gapless path).
    let deck: Deck;
    if (this.idleDeck().url === track.url) {
      deck = this.idleDeck();
      this.active ^= 1;
    } else {
      deck = this.activeDeck();
      if (deck.url !== track.url) {
        deck.el.src = track.url;
        deck.url = track.url;
      }
    }

    // Stop the now-idle deck (the previous track) cleanly.
    const other = this.idleDeck();
    other.el.pause();
    if (other.gain && this.ctx) other.gain.gain.cancelScheduledValues(this.ctx.currentTime);

    if (deck.gain) deck.gain.gain.value = gainFromDb(track.replayGainDb, track.peak);
    deck.el.currentTime = 0;
    await deck.el.play();
    this.cb.onPlayingChange(true);
    this.startProgressLoop();
  }

  resume(): void {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
    void this.activeDeck().el.play();
    this.cb.onPlayingChange(true);
    this.startProgressLoop();
  }

  pause(): void {
    this.activeDeck().el.pause();
    this.cb.onPlayingChange(false);
  }

  seek(time: number): void {
    const el = this.activeDeck().el;
    if (Number.isFinite(el.duration)) {
      el.currentTime = Math.max(0, Math.min(el.duration, time));
    }
  }

  getCurrentTime(): number {
    return this.activeDeck().el.currentTime;
  }

  stop(): void {
    for (const deck of this.decks) {
      deck.el.pause();
      deck.el.removeAttribute("src");
      deck.el.load();
      deck.url = null;
    }
    this.cb.onPlayingChange(false);
    this.stopProgressLoop();
  }

  // Begin a crossfade into a track preloaded on the idle deck. Returns false if
  // no preloaded track is available.
  private beginCrossfade(): boolean {
    const next = this.idleDeck();
    if (!next.url || !this.ctx || !this.master) return false;
    const cur = this.activeDeck();
    const now = this.ctx.currentTime;
    const dur = this.crossfadeSeconds;

    const curGain = cur.gain!;
    const nextGain = next.gain!;

    // Next deck keeps its ReplayGain target; ramp its envelope via master-relative
    // gain by starting at 0 and rising to its current value.
    const nextTarget = nextGain.gain.value || 1;
    nextGain.gain.cancelScheduledValues(now);
    nextGain.gain.setValueAtTime(0.0001, now);

    next.el.currentTime = 0;
    void next.el.play();

    nextGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, nextTarget), now + dur);
    curGain.gain.cancelScheduledValues(now);
    curGain.gain.setValueAtTime(Math.max(0.0001, curGain.gain.value), now);
    curGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    this.active ^= 1; // next deck is now active
    this.crossfading = true;
    this.cb.onCrossfadeStart();

    // After the fade, hard-stop the old deck and clear the crossfading flag so
    // the next track can itself crossfade.
    window.setTimeout(() => {
      cur.el.pause();
      cur.url = null;
      this.crossfading = false;
    }, dur * 1000 + 100);
    return true;
  }

  private handleEnded(deck: Deck): void {
    // Only react to the active deck ending naturally (ignore the deck we already
    // faded out).
    if (deck !== this.activeDeck()) return;
    if (this.crossfading) return;
    this.cb.onEnded();
  }

  private startProgressLoop(): void {
    if (this.raf) return;
    const tick = () => {
      const el = this.activeDeck().el;
      const dur = Number.isFinite(el.duration) ? el.duration : 0;
      this.cb.onProgress(el.currentTime, dur);

      // Crossfade trigger: within the fade window of the end, with a preloaded
      // next track and crossfade enabled.
      if (
        this.crossfadeSeconds > 0 &&
        !this.crossfading &&
        dur > 0 &&
        this.idleDeck().url &&
        dur - el.currentTime <= this.crossfadeSeconds
      ) {
        this.beginCrossfade();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopProgressLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
