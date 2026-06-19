// Low-level audio engine. Two "decks" (A/B), each an <audio> element.
// Volume control, crossfade, and ReplayGain normalization are done by
// manipulating element.volume directly — no Web Audio API. This avoids the
// CORS requirement that createMediaElementSource imposes (Navidrome's
// stream endpoint often doesn't send Access-Control-Allow-Origin).

export interface DeckTrack {
  url: string;
  replayGainDb: number; // 0 when normalization is off
  peak: number; // 1 when unknown; used to avoid clipping
}

interface Deck {
  el: HTMLAudioElement;
  url: string | null;
  gain: number; // ReplayGain multiplier (1 = unity)
}

export interface EngineCallbacks {
  onProgress: (time: number, duration: number) => void;
  onEnded: () => void;
  onPlayingChange: (playing: boolean) => void;
  onCrossfadeStart: () => void;
}

function gainFromDb(db: number, peak: number): number {
  if (!db) return 1;
  let linear = Math.pow(10, db / 20);
  if (peak > 0 && linear * peak > 1) linear = 1 / peak;
  return linear;
}

export class AudioEngine {
  private decks: [Deck, Deck];
  private active = 0;
  private volume = 0.8;
  private muted = false;
  private crossfadeSeconds = 0;
  private xfadeActive = false;
  private xfadeStartTime = 0; // performance.now() when xfade began
  private raf = 0;
  private cb: EngineCallbacks;

  constructor(cb: EngineCallbacks) {
    this.cb = cb;
    const mk = (index: number): Deck => {
      const el = new Audio();
      el.preload = "auto";

      el.addEventListener("playing", () => {
        if (index === this.active) {
          this.cb.onPlayingChange(true);
          this.startProgressLoop();
        }
      });

      el.addEventListener("pause", () => {
        if (index === this.active && !this.xfadeActive) {
          this.cb.onPlayingChange(false);
          this.stopProgressLoop();
        }
      });

      el.addEventListener("error", () => {
        if (index === this.active) {
          this.cb.onPlayingChange(false);
          this.stopProgressLoop();
        }
      });

      return { el, url: null, gain: 1 };
    };
    this.decks = [mk(0), mk(1)];

    for (const deck of this.decks) {
      deck.el.addEventListener("ended", () => this.handleEnded(deck));
    }
  }

  private activeDeck(): Deck {
    return this.decks[this.active];
  }
  private idleDeck(): Deck {
    return this.decks[this.active ^ 1];
  }

  private applyVolume(deck: Deck, envelope: number): void {
    deck.el.volume = Math.max(0, Math.min(1, this.muted ? 0 : this.volume * deck.gain * envelope));
  }

  setCrossfade(seconds: number): void {
    this.crossfadeSeconds = Math.max(0, Math.min(12, seconds));
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (!this.xfadeActive) {
      this.applyVolume(this.activeDeck(), 1);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    for (const d of this.decks) this.applyVolume(d, 1);
  }

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
    this.xfadeActive = false;

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

    const other = this.idleDeck();
    other.el.pause();

    deck.gain = gainFromDb(track.replayGainDb, track.peak);
    this.applyVolume(deck, 1);
    deck.el.currentTime = 0;
    try {
      await deck.el.play();
    } catch (err) {
      console.warn("AudioEngine play() failed:", err);
      this.cb.onPlayingChange(false);
      this.stopProgressLoop();
      throw err;
    }
  }

  resume(): void {
    const el = this.activeDeck().el;
    if (!el.src) return;
    void el.play();
  }

  pause(): void {
    this.activeDeck().el.pause();
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

  hasActiveTrack(): boolean {
    return !!this.activeDeck().url;
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

  private beginCrossfade(): boolean {
    const next = this.idleDeck();
    if (!next.url) return false;
    const cur = this.activeDeck();

    next.el.currentTime = 0;
    void next.el.play();

    this.xfadeActive = true;
    this.xfadeStartTime = performance.now();
    this.active ^= 1; // next deck is now active
    this.cb.onCrossfadeStart();

    const durMs = this.crossfadeSeconds * 1000;
    setTimeout(() => {
      cur.el.pause();
      cur.url = null;
      this.xfadeActive = false;
    }, durMs + 100);

    return true;
  }

  private handleEnded(deck: Deck): void {
    if (deck !== this.activeDeck()) return;
    if (this.xfadeActive) return;
    this.cb.onEnded();
  }

  private startProgressLoop(): void {
    if (this.raf) return;
    const tick = () => {
      const el = this.activeDeck().el;
      const dur = Number.isFinite(el.duration) ? el.duration : 0;
      this.cb.onProgress(el.currentTime, dur);

      if (this.xfadeActive && this.crossfadeSeconds > 0) {
        const t = Math.min((performance.now() - this.xfadeStartTime) / (this.crossfadeSeconds * 1000), 1);
        this.applyVolume(this.activeDeck(), t);       // new track: 0 → 1
        this.applyVolume(this.idleDeck(), 1 - t);    // old track: 1 → 0
      }

      if (
        this.crossfadeSeconds > 0 &&
        !this.xfadeActive &&
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
