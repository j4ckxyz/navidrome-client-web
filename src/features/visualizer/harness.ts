// Dev-only test harness for the visualiser. NOT part of the production bundle —
// it's reachable only at /viz-harness.html via the Vite dev server and exists so
// Playwright can exercise the genuine analysis + render pipeline without a
// Navidrome server.
//
// It builds a synthetic signal (an 80 Hz "bass" amplitude-modulated by a slow
// LFO, a 1 kHz "mid", and a 6 kHz "treble", each gently swelling on its own
// timer), renders it to a WAV fixture in-page, and plays that through a real
// <audio> element wired to a real AnalyserNode (fftSize 2048, smoothing 0.8) — the
// exact pipeline shape the app uses. The WAV is a same-origin blob, so the
// MediaElementSource is CORS-clean and the analyser yields real data.

import { createVizLoop } from "./loop";
import type { VizMode } from "./state";

const DURATION = 8; // seconds of fixture audio (looped)
const SAMPLE_RATE = 44100;

declare global {
  interface Window {
    __viz: {
      start(): Promise<void>;
      setMode(mode: VizMode): void;
      playing(): boolean;
      /** Current spectrum peak 0..255 — lets the test wait for real signal. */
      level(): number;
    };
  }
}

// Render the synthetic bass/mid/treble mix to an AudioBuffer offline.
async function renderFixture(): Promise<AudioBuffer> {
  const offline = new OfflineAudioContext(1, DURATION * SAMPLE_RATE, SAMPLE_RATE);

  const master = offline.createGain();
  master.gain.value = 0.9;
  master.connect(offline.destination);

  // One band = carrier oscillator → its own gain, swelled by a slow LFO so the
  // visualiser clearly sees each band move independently.
  function band(freq: number, baseGain: number, lfoHz: number, lfoDepth: number) {
    const osc = offline.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = offline.createGain();
    g.gain.value = baseGain;
    const lfo = offline.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = lfoHz;
    const lfoGain = offline.createGain();
    lfoGain.gain.value = lfoDepth;
    lfo.connect(lfoGain).connect(g.gain);
    osc.connect(g).connect(master);
    osc.start();
    lfo.start();
  }

  band(80, 0.5, 0.8, 0.45); // bass, throbbing
  band(1000, 0.28, 0.33, 0.22); // mid, slow swell
  band(6000, 0.16, 1.7, 0.13); // treble, shimmer

  return offline.startRendering();
}

// Encode a mono AudioBuffer as a 16-bit PCM WAV blob.
function encodeWav(buffer: AudioBuffer): Blob {
  const samples = buffer.getChannelData(0);
  const n = samples.length;
  const bytes = new ArrayBuffer(44 + n * 2);
  const view = new DataView(bytes);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([bytes], { type: "audio/wav" });
}

async function main(): Promise<void> {
  const canvas = document.getElementById("viz-canvas") as HTMLCanvasElement;
  const audio = document.getElementById("viz-audio") as HTMLAudioElement;
  const status = document.getElementById("viz-status") as HTMLElement;

  const params = new URLSearchParams(location.search);
  let mode = (params.get("mode") as VizMode) || "classic";

  // Build the WAV fixture and point the real <audio> element at it.
  const buffer = await renderFixture();
  const wav = encodeWav(buffer);
  audio.src = URL.createObjectURL(wav);
  audio.loop = true;
  audio.crossOrigin = "anonymous"; // matches the app; blob is same-origin anyway

  // Real Web Audio graph: <audio> → MediaElementSource → AnalyserNode → speakers.
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();
  const source = audioCtx.createMediaElementSource(audio);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);
  analyser.connect(audioCtx.destination);

  const peakBuf = new Uint8Array(analyser.frequencyBinCount);
  const level = () => {
    analyser.getByteFrequencyData(peakBuf);
    let p = 0;
    for (let i = 0; i < peakBuf.length; i++) if (peakBuf[i] > p) p = peakBuf[i];
    return p;
  };

  createVizLoop({
    canvas,
    analyser,
    isPlaying: () => !audio.paused,
    mode: () => mode,
    // No cover art in the harness — exercise the default palette path.
  });

  window.__viz = {
    async start() {
      await audioCtx.resume();
      await audio.play();
      status.textContent = "playing";
    },
    setMode(m: VizMode) {
      mode = m;
      status.dataset.mode = m;
    },
    playing: () => !audio.paused,
    level,
  };

  status.textContent = "ready";
  status.dataset.ready = "1";
}

void main();
