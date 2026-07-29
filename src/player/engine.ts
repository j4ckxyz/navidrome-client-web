// Low-level audio engine. Two "decks" (A/B), each an <audio> element.
// Volume control, crossfade, and ReplayGain normalization are done by
// manipulating element.volume directly — no Web Audio API by default. This
// avoids the CORS requirement that createMediaElementSource imposes (Navidrome's
// stream endpoint often doesn't send Access-Control-Allow-Origin).
//
// The equalizer is the one feature that *needs* Web Audio: when enabled it taps
// each deck through a chain of peaking BiquadFilters. createMediaElementSource
// requires the media to be CORS-clean, so enabling the EQ sets crossOrigin on
// the elements and reloads them. This works transparently when the app is served
// in proxy mode (streams are same-origin); in direct mode it needs the Navidrome
// server to send CORS headers. element.volume keeps working through the graph, so
// volume/crossfade/ReplayGain are unaffected.

import { EQ_FREQUENCIES, EQ_BAND_COUNT } from "~/settings/schema";

export interface DeckTrack {
  url: string;
  replayGainDb: number; // 0 when normalization is off
  peak: number; // 1 when unknown; used to avoid clipping
  // Seconds the server already skipped before the first byte of this stream.
  // Non-zero only when a seek was satisfied server-side (Jellyfin transcode).
  startOffset?: number;
  // False for a live server-side transcode: the response has no stable
  // byte↔time mapping, so moving element.currentTime lands somewhere arbitrary.
  // The player re-requests the stream from a new offset instead.
  canSeek?: boolean;
  // Known length from metadata, used when the element can't report its own
  // (progressive transcodes have no Content-Length, so duration is Infinity or
  // a drifting estimate).
  duration?: number;
}

export interface EqualizerState {
  enabled: boolean;
  preampDb: number;
  gains: number[]; // length EQ_BAND_COUNT
}

interface Deck {
  el: HTMLAudioElement;
  url: string | null;
  gain: number; // ReplayGain multiplier (1 = unity)
  startOffset: number;
  canSeek: boolean;
  duration: number; // 0 = unknown, fall back to the element
}

// The Web Audio graph for a single deck:
//   source → preamp → peaking filters → limiter → destination
// The limiter is a brick-wall DynamicsCompressor that catches the peaks a band
// boost can push past 0 dBFS — without it, boosting (e.g. Bass Boost) clips and
// sounds crackly/distorted.
interface EqChain {
  source: MediaElementAudioSourceNode;
  preamp: GainNode;
  filters: BiquadFilterNode[];
  limiter: DynamicsCompressorNode;
}

export interface EngineCallbacks {
  onProgress: (time: number, duration: number) => void;
  onEnded: () => void;
  onPlayingChange: (playing: boolean) => void;
  onCrossfadeStart: () => void;
  // The element refused the media (decode error, 404, dead transcode). The
  // player decides whether to retry transcoded or skip on.
  onError: (code: number | undefined) => void;
  // A seek was requested on a stream the element can't scrub. The player
  // re-resolves the stream starting at `time` instead.
  onSeekUnsupported: (time: number) => void;
}

function clampDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(-12, Math.min(12, db));
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

  // Equalizer (Web Audio). The graph is built lazily on first enable and never
  // torn down — createMediaElementSource is irreversible — so "disabling" just
  // flattens the filters. `eqActive` mirrors whether the graph is currently
  // shaping audio.
  private audioCtx: AudioContext | null = null;
  private eqChains: [EqChain | null, EqChain | null] = [null, null];
  private eqActive = false;
  // Analyser tapping the master output for the now-playing visualizer. Shares
  // the same lazily-built graph as the EQ (both decks feed it), so it reflects
  // exactly what you hear — EQ, crossfade, ReplayGain and all.
  private analyser: AnalyserNode | null = null;
  private eqPreampDb = 0;
  private eqGains: number[] = new Array(EQ_BAND_COUNT).fill(0);

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
        // Tearing a deck down (stop(), or swapping src) can surface an error on
        // an element we no longer care about. Only a deck that's meant to be
        // playing something counts as a real failure.
        if (index !== this.active || !this.decks[index].url) return;
        this.cb.onPlayingChange(false);
        this.stopProgressLoop();
        this.cb.onError(el.error?.code);
      });

      return { el, url: null, gain: 1, startOffset: 0, canSeek: true, duration: 0 };
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

  // --- Equalizer ---

  // Apply EQ state. The first time it's enabled we build the Web Audio graph
  // (which requires CORS-clean media, so we set crossOrigin and reload sources).
  // Returns false if enabling failed (e.g. Web Audio unavailable). Band gains
  // and pre-amp update live without rebuilding.
  setEqualizer(state: EqualizerState): boolean {
    this.eqPreampDb = clampDb(state.preampDb);
    this.eqGains = EQ_FREQUENCIES.map((_, i) => clampDb(state.gains[i] ?? 0));

    if (state.enabled && !this.audioCtx) {
      if (!this.buildEqGraph()) return false;
    }
    this.eqActive = state.enabled && !!this.audioCtx;
    this.applyEqValues();
    return !state.enabled || this.eqActive;
  }

  isEqualizerAvailable(): boolean {
    return typeof window !== "undefined" && "AudioContext" in window;
  }

  // --- Visualizer ---

  // Ensure the Web Audio graph exists and return the master analyser. Building
  // the graph reloads the current sources as CORS-clean (same as the EQ), so the
  // analyser only yields real data when streams are same-origin (proxy mode) or
  // the server sends CORS headers. Returns null if Web Audio is unavailable.
  enableAnalyser(): AnalyserNode | null {
    if (!this.audioCtx) {
      if (!this.buildEqGraph()) return null;
      this.applyEqValues(); // keep EQ transparent unless it's actually on
    }
    this.resumeContext();
    return this.analyser;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  // One-time construction of the AudioContext and per-deck filter chains. Sets
  // crossOrigin on both elements and reloads any in-flight source so the graph
  // receives real samples rather than silence.
  private buildEqGraph(): boolean {
    if (this.audioCtx) return true;
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return false;
    try {
      this.audioCtx = new Ctx();
    } catch (err) {
      console.warn("Equalizer: could not create AudioContext", err);
      return false;
    }

    // Master analyser: every deck's chain terminates here, and it forwards to
    // the speakers. Built before the chains so they can connect into it.
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    // Lower smoothing keeps real frequency spikes crisp (otherwise the spectrum
    // reads as soft, stretched humps); the visualizer adds its own gentle easing.
    this.analyser.smoothingTimeConstant = 0.65;
    this.analyser.minDecibels = -85;
    this.analyser.maxDecibels = -12;
    this.analyser.connect(this.audioCtx.destination);

    for (let i = 0; i < this.decks.length; i++) {
      const deck = this.decks[i];
      this.makeCrossOrigin(deck);
      try {
        this.eqChains[i] = this.buildChain(deck);
      } catch (err) {
        console.warn("Equalizer: could not build filter chain", err);
      }
    }
    return true;
  }

  // Set crossOrigin on a deck and reload its current source in place, preserving
  // playback position and play/pause state. No-op if already cross-origin or idle.
  private makeCrossOrigin(deck: Deck): void {
    if (deck.el.crossOrigin === "anonymous") return;
    deck.el.crossOrigin = "anonymous";
    if (!deck.url) return;
    const wasPlaying = !deck.el.paused;
    const time = deck.el.currentTime;
    deck.el.src = deck.url;
    deck.el.load();
    if (time > 0) {
      const restore = () => {
        try {
          deck.el.currentTime = time;
        } catch {
          // ignore — element not yet seekable
        }
        deck.el.removeEventListener("loadedmetadata", restore);
      };
      deck.el.addEventListener("loadedmetadata", restore);
    }
    if (wasPlaying) void deck.el.play();
  }

  private buildChain(deck: Deck): EqChain {
    const ctx = this.audioCtx!;
    const source = ctx.createMediaElementSource(deck.el);
    const preamp = ctx.createGain();
    const filters = EQ_FREQUENCIES.map((freq, i) => {
      const f = ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = freq;
      f.Q.value = 1.1;
      f.gain.value = this.eqGains[i] ?? 0;
      return f;
    });
    // Brick-wall limiter to stop boosted peaks from clipping (the crackle).
    const limiter = ctx.createDynamicsCompressor();
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    // source → preamp → f0 → f1 → … → limiter → destination
    source.connect(preamp);
    let node: AudioNode = preamp;
    for (const f of filters) {
      node.connect(f);
      node = f;
    }
    node.connect(limiter);
    // Terminate at the master analyser (which feeds the destination), so the
    // visualizer sees the fully-processed signal.
    limiter.connect(this.analyser ?? ctx.destination);
    return { source, preamp, filters, limiter };
  }

  // Push the current gains/pre-amp to the live nodes. When inactive, flatten to
  // unity so the graph is a transparent passthrough.
  private applyEqValues(): void {
    // When EQ is on, pull the whole signal down by the largest boost so a band
    // sitting at +12 dB has real headroom before the limiter, rather than
    // slamming it. The limiter then only has to catch transient peaks.
    const maxBoost = this.eqActive ? Math.max(0, ...this.eqGains, this.eqPreampDb) : 0;
    const headroomDb = -0.7 * maxBoost; // gentle compensation, not full cut
    for (const chain of this.eqChains) {
      if (!chain) continue;
      chain.preamp.gain.value = this.eqActive
        ? Math.pow(10, (this.eqPreampDb + headroomDb) / 20)
        : 1;
      chain.filters.forEach((f, i) => {
        f.gain.value = this.eqActive ? this.eqGains[i] ?? 0 : 0;
      });
      // Engage the limiter only when shaping audio; transparent (threshold at
      // the ceiling) when the EQ is off so passthrough stays bit-clean.
      chain.limiter.threshold.value = this.eqActive ? -2 : 0;
    }
  }

  // Resume a suspended context (autoplay policy parks it until a user gesture).
  private resumeContext(): void {
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      void this.audioCtx.resume();
    }
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

  private applyTrack(deck: Deck, track: DeckTrack): void {
    deck.url = track.url;
    deck.startOffset = track.startOffset ?? 0;
    deck.canSeek = track.canSeek !== false;
    deck.duration = track.duration ?? 0;
  }

  prepareNext(track: DeckTrack | null): void {
    const idle = this.idleDeck();
    if (!track) {
      idle.url = null;
      return;
    }
    if (idle.url === track.url) return;
    idle.el.src = track.url;
    this.applyTrack(idle, track);
    idle.el.load();
  }

  async play(track: DeckTrack): Promise<void> {
    this.xfadeActive = false;
    this.resumeContext();

    let deck: Deck;
    if (this.idleDeck().url === track.url) {
      deck = this.idleDeck();
      this.active ^= 1;
      this.applyTrack(deck, track);
    } else {
      deck = this.activeDeck();
      // Always re-assign src, even when the URL matches: replaying the current
      // track (repeat-one, or a restart after a seek on a transcode) has to pull
      // a fresh stream rather than reuse a response that has already played out.
      deck.el.src = track.url;
      this.applyTrack(deck, track);
    }

    const other = this.idleDeck();
    other.el.pause();

    deck.gain = gainFromDb(track.replayGainDb, track.peak);
    this.applyVolume(deck, 1);
    // A fresh stream already starts at zero, and assigning currentTime before
    // metadata arrives throws on some browsers.
    if (deck.el.currentTime > 0 && deck.el.seekable.length > 0) {
      try {
        deck.el.currentTime = 0;
      } catch {
        // not seekable yet — it starts at zero anyway
      }
    }
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
    this.resumeContext();
    void el.play();
  }

  pause(): void {
    this.activeDeck().el.pause();
  }

  // Gently ramp the active deck to silence over `seconds`, then pause and reset
  // its element volume so the next play starts at full level. Used by the sleep
  // timer so playback drifts off rather than cutting out.
  fadeOutAndPause(seconds = 4): void {
    const deck = this.activeDeck();
    if (deck.el.paused) return;
    const startVol = deck.el.volume;
    const startTime = performance.now();
    const durMs = Math.max(200, seconds * 1000);
    const step = () => {
      if (deck.el.paused) return; // user intervened
      const t = Math.min((performance.now() - startTime) / durMs, 1);
      deck.el.volume = Math.max(0, startVol * (1 - t));
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        deck.el.pause();
        this.applyVolume(deck, 1); // restore intended level for next play
      }
    };
    requestAnimationFrame(step);
  }

  // `time` is absolute within the track, i.e. it already includes any offset the
  // server applied when the stream was opened.
  seek(time: number): void {
    const deck = this.activeDeck();
    const target = Math.max(0, time);
    if (!deck.canSeek) {
      // A live transcode can't be scrubbed in place — ask the player to reopen
      // the stream at the new position.
      this.cb.onSeekUnsupported(target);
      return;
    }
    const el = deck.el;
    if (Number.isFinite(el.duration)) {
      el.currentTime = Math.max(0, Math.min(el.duration, target - deck.startOffset));
    }
  }

  getCurrentTime(): number {
    const deck = this.activeDeck();
    return deck.el.currentTime + deck.startOffset;
  }

  // Whether the current stream can be scrubbed without reopening it.
  isSeekable(): boolean {
    return this.activeDeck().canSeek;
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
      deck.startOffset = 0;
      deck.canSeek = true;
      deck.duration = 0;
    }
    this.cb.onPlayingChange(false);
    this.stopProgressLoop();
  }

  private beginCrossfade(): boolean {
    const next = this.idleDeck();
    if (!next.url) return false;
    const cur = this.activeDeck();

    if (next.el.currentTime > 0 && next.el.seekable.length > 0) {
      try {
        next.el.currentTime = 0;
      } catch {
        // preloaded stream isn't seekable yet — it plays from its start anyway
      }
    }
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
      const deck = this.activeDeck();
      const el = deck.el;
      // A seekable deck is a real file, so its own duration is exact — prefer
      // it. A progressive transcode reports Infinity or a drifting estimate
      // instead, which makes the scrubber jitter and fires the scrobble
      // threshold at the wrong moment; there, trust the server's metadata.
      const elementDur = Number.isFinite(el.duration) ? el.duration : 0;
      const dur = deck.canSeek
        ? elementDur || deck.duration
        : deck.duration || elementDur;
      this.cb.onProgress(el.currentTime + deck.startOffset, dur);

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
        dur - (el.currentTime + deck.startOffset) <= this.crossfadeSeconds
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
