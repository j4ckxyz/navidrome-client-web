// Audio analysis for the immersive visualiser. Pulls the spectrum and waveform
// off a Web Audio AnalyserNode every frame and boils them down to the handful of
// numbers the renderers actually want: overall amplitude, three frequency bands
// (bass / mid / treble), a fast beat pulse, plus the raw log-binned spectrum and
// the oscilloscope waveform.
//
// It is deliberately decoupled from the player engine: pass it any AnalyserNode
// (the engine's master tap in the app, or a throwaway one wired to a synthetic
// signal in tests) and it behaves identically. When there's no analyser, or the
// source is silent/tainted (a cross-origin stream blanks the data with no error),
// it falls back to a gentle synthesized signal so the scene never looks frozen.

export interface VizFrame {
  /** Overall loudness, 0..1 (time-domain RMS, lightly smoothed). */
  amplitude: number;
  /** Low-end energy, 0..1 (sustained swell — quick attack, slow release). */
  bass: number;
  /** Midrange energy, 0..1. */
  mid: number;
  /** High-end energy, 0..1. */
  treble: number;
  /** Transient kick/onset pulse, 0..1 (fast attack, fast decay). */
  beat: number;
  /** Log-binned spectrum, each value 0..1. Length = SPECTRUM_BINS. */
  spectrum: Float32Array;
  /** Oscilloscope samples, each -1..1. Length = WAVEFORM_POINTS. */
  waveform: Float32Array;
  /** Whether playback is currently running. */
  playing: boolean;
  /** True when real analyser data is flowing (false ⇒ synthesized fallback). */
  real: boolean;
}

export const SPECTRUM_BINS = 96;
export const WAVEFORM_POINTS = 256;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface AnalysisOptions {
  /** Provide the current play state so the synth fallback can go quiet. */
  isPlaying: () => boolean;
}

// One reusable analyser reader. Allocates its buffers once and mutates a single
// VizFrame in place each tick, so the render loop never churns the GC.
export function createAnalysis(analyser: AnalyserNode | null, opts: AnalysisOptions) {
  const freq = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  const wave = analyser ? new Uint8Array(analyser.fftSize) : null;

  const spectrum = new Float32Array(SPECTRUM_BINS);
  const waveform = new Float32Array(WAVEFORM_POINTS);

  const frame: VizFrame = {
    amplitude: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    beat: 0,
    spectrum,
    waveform,
    playing: false,
    real: false,
  };

  // Smoothed running values (the analyser's own smoothingTimeConstant gets us
  // most of the way; these add the satisfying attack/release shaping on top).
  let amp = 0;
  let bass = 0;
  let mid = 0;
  let treble = 0;
  let bassBaseline = 0; // slow baseline for transient detection
  let beat = 0;

  // Fallback latch: if we have an analyser but it reads flat for a while during
  // playback (tainted/cross-origin source, or just genuine silence) switch to a
  // synthesized signal, and switch straight back the instant real data returns.
  let flatFrames = 0;
  let useSynth = !analyser;
  const startTime = (typeof performance !== "undefined" ? performance : Date).now();

  // Average a contiguous slice of FFT bins to a 0..1 level.
  function bandLevel(lo: number, hi: number): number {
    if (!freq) return 0;
    const a = Math.max(0, lo);
    const b = Math.min(freq.length - 1, hi);
    let sum = 0;
    for (let i = a; i <= b; i++) sum += freq[i];
    return sum / ((b - a + 1) * 255);
  }

  function read(): VizFrame {
    const playing = opts.isPlaying();
    const t = ((typeof performance !== "undefined" ? performance : Date).now() - startTime) / 1000;

    let bassRaw = 0;
    let midRaw = 0;
    let trebleRaw = 0;
    let ampRaw = 0;

    if (analyser && freq && wave) {
      analyser.getByteFrequencyData(freq);
      analyser.getByteTimeDomainData(wave);

      let peak = 0;
      for (let i = 0; i < freq.length; i++) if (freq[i] > peak) peak = freq[i];
      if (playing && peak < 2) {
        if (++flatFrames > 150) useSynth = true; // ~2.5s flat → synthesize
      } else {
        flatFrames = 0;
        if (peak >= 2) useSynth = false; // real audio is back
      }

      if (!useSynth) {
        // Bins at 44.1kHz / 2048 fft ≈ 21.5 Hz each.
        bassRaw = bandLevel(2, 16); //  ~40–340 Hz
        midRaw = bandLevel(17, 120); // ~360 Hz–2.6 kHz
        trebleRaw = bandLevel(121, 460); // ~2.6–9.9 kHz

        // Log-spaced spectrum so musical content spreads across the width.
        const minBin = 2;
        const maxBin = Math.min(freq.length - 1, 560);
        for (let i = 0; i < SPECTRUM_BINS; i++) {
          const b0 = Math.floor(minBin * Math.pow(maxBin / minBin, i / SPECTRUM_BINS));
          const b1 = Math.max(
            b0 + 1,
            Math.floor(minBin * Math.pow(maxBin / minBin, (i + 1) / SPECTRUM_BINS)),
          );
          let sum = 0;
          for (let b = b0; b < b1; b++) sum += freq[b];
          spectrum[i] = Math.pow(sum / (b1 - b0) / 255, 1.35); // gamma for punch
        }

        // Time-domain RMS for overall amplitude, and a downsampled scope trace.
        let sumSq = 0;
        for (let i = 0; i < wave.length; i++) {
          const v = (wave[i] - 128) / 128;
          sumSq += v * v;
        }
        ampRaw = Math.min(1, Math.sqrt(sumSq / wave.length) * 2.2);
        for (let i = 0; i < WAVEFORM_POINTS; i++) {
          const idx = Math.floor((i / WAVEFORM_POINTS) * wave.length);
          waveform[i] = (wave[idx] - 128) / 128;
        }
      }
    }

    if (useSynth) {
      // Three independent ebbing oscillators so bass/mid/treble move apart, like
      // real music. Goes quiet (but not dead) when paused.
      const energy = playing ? 1 : 0.04;
      bassRaw = (0.5 + 0.5 * Math.sin(t * 2.6)) ** 2 * energy;
      midRaw = (0.45 + 0.45 * Math.sin(t * 1.7 + 1.3)) * energy;
      trebleRaw = (0.4 + 0.4 * Math.abs(Math.sin(t * 4.1 + 0.6))) * energy;
      ampRaw = (0.4 + 0.35 * Math.sin(t * 3.0)) * energy;
      for (let i = 0; i < SPECTRUM_BINS; i++) {
        const f = i / SPECTRUM_BINS;
        const a =
          0.5 +
          0.5 * Math.sin(t * 2.1 + f * 9) * Math.sin(t * 0.7 + f * 3.3) +
          0.15 * Math.sin(t * 5 + f * 20);
        spectrum[i] = Math.max(0, a) * (1 - f * 0.5) * energy;
      }
      for (let i = 0; i < WAVEFORM_POINTS; i++) {
        waveform[i] =
          (Math.sin(i * 0.18 + t * 6) * 0.5 + Math.sin(i * 0.07 - t * 3) * 0.3) * energy;
      }
    }

    // Attack/release smoothing: rise fast, fall slow — reads as punchy.
    amp = lerp(amp, ampRaw, ampRaw > amp ? 0.5 : 0.12);
    bass = lerp(bass, bassRaw, bassRaw > bass ? 0.55 : 0.12);
    mid = lerp(mid, midRaw, midRaw > mid ? 0.5 : 0.14);
    treble = lerp(treble, trebleRaw, trebleRaw > treble ? 0.5 : 0.16);

    // Beat: how far this frame's bass jumps above its slow baseline, scaled by
    // the size of the jump so a hard kick punches further than a soft one.
    bassBaseline = lerp(bassBaseline, bassRaw, 0.05);
    const jump = Math.max(0, bassRaw - bassBaseline * 1.1);
    beat = Math.max(beat * 0.82, Math.min(1, jump * 2.6));

    frame.amplitude = amp;
    frame.bass = bass;
    frame.mid = mid;
    frame.treble = treble;
    frame.beat = beat;
    frame.playing = playing;
    frame.real = !useSynth;
    return frame;
  }

  return { read };
}

export type Analysis = ReturnType<typeof createAnalysis>;
