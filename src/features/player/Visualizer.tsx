// Real-time audio visualizer for the full-screen player. Reads the engine's
// master AnalyserNode (same signal you hear) and paints a themed, music-reactive
// background: a glowing frequency ridge along the bottom, an oscilloscope wave
// through the centre, and a bass-driven aura that pulses the album art.
//
// It degrades gracefully: with no real audio data (Web Audio unavailable, or a
// tainted cross-origin stream) it falls back to a gentle synthesized motion so
// the scene never looks dead. Honors prefers-reduced-motion by rendering nothing.

import { createEffect, onCleanup, onMount } from "solid-js";
import { player } from "~/player/store";

interface RGB {
  r: number;
  g: number;
  b: number;
}

const DEFAULT_COLORS: RGB[] = [
  { r: 110, g: 168, b: 255 },
  { r: 155, g: 108, b: 255 },
  { r: 255, g: 110, b: 199 },
];

function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Bump a colour's perceived vividness so dim covers still glow nicely on screen.
function liven(c: RGB): RGB {
  const max = Math.max(c.r, c.g, c.b, 1);
  const boost = Math.min(1.7, 200 / max);
  return {
    r: Math.min(255, c.r * boost),
    g: Math.min(255, c.g * boost),
    b: Math.min(255, c.b * boost),
  };
}

const rgba = (c: RGB, a: number) => `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${a})`;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

export function Visualizer(props: { colors: string[] }) {
  let canvas: HTMLCanvasElement | undefined;

  // Themed palette: livened cover colours, or pleasant defaults. Reactive so it
  // follows track changes while the component stays mounted.
  let palette: RGB[] = DEFAULT_COLORS;
  createEffect(() => {
    let p = props.colors
      .map(hexToRgb)
      .filter((c): c is RGB => !!c)
      .map(liven);
    if (p.length === 0) p = DEFAULT_COLORS;
    if (p.length === 1) p = [p[0], mixRgb(p[0], DEFAULT_COLORS[2], 0.5)];
    palette = p;
  });

  onMount(() => {
    if (!canvas) return;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const analyser = player.enableVisualizer();
    const freq = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    const wave = analyser ? new Uint8Array(analyser.fftSize) : null;

    const BARS = 64;
    const heights = new Float32Array(BARS); // smoothed bar heights, 0..1
    let bass = 0; // smoothed low-frequency energy 0..1
    let waveSm = new Float32Array(0); // smoothed oscilloscope samples

    // Fallback detection: if we expect audio but the analyser is flat, switch to
    // a synthesized animation after a beat so direct-mode users still get motion.
    let flatFrames = 0;
    let useSynth = !analyser;

    let dpr = 1;
    let w = 0;
    let h = 0;
    function resize() {
      if (!canvas) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Colour at gradient position p in [0,1] across the palette.
    function colorAt(p: number): RGB {
      const n = palette.length - 1;
      if (n <= 0) return palette[0];
      const x = Math.max(0, Math.min(0.9999, p)) * n;
      const i = Math.floor(x);
      return mixRgb(palette[i], palette[i + 1], x - i);
    }

    const startTime = performance.now();
    let raf = 0;

    function frame() {
      raf = requestAnimationFrame(frame);
      if (!canvas) return;
      const playing = player.state.isPlaying;
      const t = (performance.now() - startTime) / 1000;

      // --- Gather frequency + waveform data (real or synthesized) ---
      const spectrum = new Float32Array(BARS);
      let bassRaw = 0;

      if (analyser && freq && wave && !useSynth) {
        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(wave);

        let peak = 0;
        // Log-spaced bins so musical content spreads across the width.
        const minBin = 2;
        const maxBin = Math.min(freq.length - 1, 560);
        for (let i = 0; i < BARS; i++) {
          const b0 = Math.floor(minBin * Math.pow(maxBin / minBin, i / BARS));
          const b1 = Math.max(b0 + 1, Math.floor(minBin * Math.pow(maxBin / minBin, (i + 1) / BARS)));
          let sum = 0;
          for (let b = b0; b < b1; b++) sum += freq[b];
          const v = sum / (b1 - b0) / 255;
          spectrum[i] = Math.pow(v, 1.35); // gamma for punchier dynamics
          if (freq[i] > peak) peak = freq[i];
        }
        for (let b = 2; b < 14; b++) bassRaw += freq[b];
        bassRaw = bassRaw / (12 * 255);

        // Detect a persistently silent analyser while we believe audio is on.
        if (playing && peak < 2) {
          if (++flatFrames > 90) useSynth = true;
        } else {
          flatFrames = 0;
        }
      }

      if (useSynth) {
        // Synthesized spectrum: layered sines that ebb and flow. Quiet when paused.
        const energy = playing ? 1 : 0;
        for (let i = 0; i < BARS; i++) {
          const f = i / BARS;
          const a =
            0.5 +
            0.5 * Math.sin(t * 2.1 + f * 9) * Math.sin(t * 0.7 + f * 3.3) +
            0.15 * Math.sin(t * 5 + f * 20);
          spectrum[i] = Math.max(0, a) * (1 - f * 0.5) * energy;
        }
        bassRaw = (playing ? 0.55 + 0.45 * Math.sin(t * 3.0) : 0) ** 2;
      }

      // --- Smooth toward targets (fast attack, slow release = satisfying) ---
      for (let i = 0; i < BARS; i++) {
        const target = spectrum[i];
        const k = target > heights[i] ? 0.45 : 0.12;
        heights[i] = lerp(heights[i], target, k);
      }
      bass = lerp(bass, bassRaw, bassRaw > bass ? 0.4 : 0.09);

      // Pulse the album art via a CSS variable on the player root.
      const root = canvas.parentElement;
      if (root) (root as HTMLElement).style.setProperty("--fs-beat", String(1 + bass * 0.05));

      // --- Paint ---
      ctx!.clearRect(0, 0, w, h);

      // 1) Bass aura: a soft radial glow centred behind the artwork.
      const cx = w / 2;
      const cy = h * 0.42;
      const auraR = Math.min(w, h) * (0.28 + bass * 0.22);
      const aura = ctx!.createRadialGradient(cx, cy, 0, cx, cy, auraR);
      const auraCol = colorAt(0.5);
      aura.addColorStop(0, rgba(auraCol, 0.16 + bass * 0.22));
      aura.addColorStop(0.6, rgba(auraCol, 0.05));
      aura.addColorStop(1, rgba(auraCol, 0));
      ctx!.fillStyle = aura;
      ctx!.fillRect(0, 0, w, h);

      // 2) Oscilloscope wave through the centre — the literal waveform.
      drawWave(t, playing);

      // 3) Frequency ridge along the bottom (mirrored, glowing).
      drawRidge();
    }

    function drawWave(t: number, playing: boolean) {
      const midY = h * 0.5;
      const amp = h * 0.12;
      const n = 140;
      if (waveSm.length !== n) waveSm = new Float32Array(n);

      const col = colorAt(0.5);
      ctx!.save();
      ctx!.globalCompositeOperation = "lighter";
      ctx!.lineWidth = 2;
      ctx!.strokeStyle = rgba(col, playing ? 0.5 : 0.18);
      ctx!.shadowBlur = 16;
      ctx!.shadowColor = rgba(col, 0.6);
      ctx!.beginPath();
      for (let i = 0; i < n; i++) {
        let sample: number;
        if (analyser && wave && !useSynth) {
          const idx = Math.floor((i / n) * wave.length);
          sample = (wave[idx] - 128) / 128;
        } else {
          sample = playing
            ? Math.sin(i * 0.18 + t * 6) * 0.5 + Math.sin(i * 0.07 - t * 3) * 0.3
            : 0;
        }
        // Taper the ends so the line fades into the edges.
        const taper = Math.sin((i / (n - 1)) * Math.PI);
        waveSm[i] = lerp(waveSm[i], sample * taper, 0.5);
        const x = (i / (n - 1)) * w;
        const y = midY + waveSm[i] * amp;
        if (i === 0) ctx!.moveTo(x, y);
        else ctx!.lineTo(x, y);
      }
      ctx!.stroke();
      ctx!.restore();
    }

    function drawRidge() {
      const baseY = h + 2;
      const maxH = h * 0.5;
      const step = w / (BARS - 1);

      // Filled, smoothed area under the spectrum.
      ctx!.save();
      ctx!.globalCompositeOperation = "lighter";

      const grad = ctx!.createLinearGradient(0, baseY - maxH, 0, baseY);
      grad.addColorStop(0, rgba(colorAt(0.85), 0.55));
      grad.addColorStop(0.5, rgba(colorAt(0.4), 0.4));
      grad.addColorStop(1, rgba(colorAt(0.1), 0.05));
      ctx!.fillStyle = grad;

      ctx!.beginPath();
      ctx!.moveTo(0, baseY);
      const py = (i: number) => baseY - heights[Math.max(0, Math.min(BARS - 1, i))] * maxH;
      ctx!.lineTo(0, py(0));
      for (let i = 0; i < BARS - 1; i++) {
        const x = i * step;
        const xn = (i + 1) * step;
        const xc = (x + xn) / 2;
        ctx!.quadraticCurveTo(x, py(i), xc, (py(i) + py(i + 1)) / 2);
      }
      ctx!.lineTo(w, py(BARS - 1));
      ctx!.lineTo(w, baseY);
      ctx!.closePath();
      ctx!.fill();

      // Glowing crest line on top of the ridge.
      ctx!.lineWidth = 2.5;
      ctx!.strokeStyle = rgba(colorAt(0.95), 0.9);
      ctx!.shadowBlur = 18;
      ctx!.shadowColor = rgba(colorAt(0.8), 0.8);
      ctx!.beginPath();
      ctx!.moveTo(0, py(0));
      for (let i = 0; i < BARS - 1; i++) {
        const x = i * step;
        const xn = (i + 1) * step;
        const xc = (x + xn) / 2;
        ctx!.quadraticCurveTo(x, py(i), xc, (py(i) + py(i + 1)) / 2);
      }
      ctx!.lineTo(w, py(BARS - 1));
      ctx!.stroke();
      ctx!.restore();
    }

    raf = requestAnimationFrame(frame);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas?.parentElement?.style.removeProperty("--fs-beat");
    });
  });

  return <canvas ref={canvas} class="fs-visualizer" aria-hidden="true" />;
}
