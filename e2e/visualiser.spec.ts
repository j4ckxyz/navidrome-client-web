// Visual smoke test for the music visualiser.
//
// What it does, per mode (Classic + Magnetosphere):
//   1. Opens /viz-harness.html, which plays a synthetic bass/mid/treble signal
//      through the REAL <audio> → AnalyserNode → render pipeline.
//   2. Waits until real spectrum data is actually flowing (not the synth fallback).
//   3. Captures the canvas every 200ms for ~5s with locator.screenshot() — the
//      compositor output, NOT canvas.toDataURL() (which can read back blank on a
//      cleared/!preserveDrawingBuffer canvas).
//   4. Assembles the frames into an animated GIF with ffmpeg, for eyeballing.
//   5. Asserts consecutive frames differ by more than a small pixel threshold, so
//      a frozen/static canvas regression fails automatically.
//
// Run + output locations: see e2e/README.md.

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

declare global {
  interface Window {
    __viz: {
      start(): Promise<void>;
      setMode(mode: "classic" | "magnetosphere"): void;
      playing(): boolean;
      level(): number;
    };
  }
}

const OUT_ROOT = join("test-results", "visualiser");
const MODES = ["classic", "magnetosphere"] as const;
const FRAMES = 25; // ~5s at 200ms
const INTERVAL_MS = 200;

// Compute, in-page, the mean absolute luminance difference between successive PNG
// frames (normalised 0..1). Decodes each PNG with createImageBitmap and
// downscales to 160×90 for a fast compare. A continuous metric (rather than a
// thresholded changed-pixel count) is used deliberately: it reads exactly 0 only
// for a genuinely frozen canvas, yet still registers slow, smooth plasma motion
// that a per-pixel threshold would miss between two closely-spaced frames.
async function pairwiseDiffs(
  page: import("@playwright/test").Page,
  framesB64: string[],
): Promise<number[]> {
  return page.evaluate(async (b64s) => {
    const W = 160;
    const H = 90;
    const cnv = document.createElement("canvas");
    cnv.width = W;
    cnv.height = H;
    const ctx = cnv.getContext("2d", { willReadFrequently: true })!;
    async function lum(b64: string): Promise<Float32Array> {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      ctx.drawImage(bmp, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      const out = new Float32Array(W * H);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        out[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      }
      return out;
    }
    const diffs: number[] = [];
    let prev = await lum(b64s[0]);
    for (let i = 1; i < b64s.length; i++) {
      const cur = await lum(b64s[i]);
      let sum = 0;
      for (let p = 0; p < cur.length; p++) sum += Math.abs(cur[p] - prev[p]);
      diffs.push(sum / cur.length);
      prev = cur;
    }
    return diffs;
  }, framesB64);
}

for (const mode of MODES) {
  test(`visualiser "${mode}" reacts to the synthetic signal`, async ({ page }) => {
    const outDir = join(OUT_ROOT, mode);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    await page.goto(`/viz-harness.html?mode=${mode}`);
    await page.waitForSelector("#viz-status[data-ready='1']", { timeout: 20_000 });

    // Start audio + select the mode, then wait for genuine spectrum energy so we
    // know the real analyser path (not the synth fallback) is what we're filming.
    await page.evaluate(() => window.__viz.start());
    await page.evaluate((m) => window.__viz.setMode(m), mode);
    await expect
      .poll(() => page.evaluate(() => window.__viz.level()), {
        message: "spectrum never showed real energy — audio pipeline may be broken",
        timeout: 8_000,
      })
      .toBeGreaterThan(20);

    const canvas = page.locator("#viz-canvas");
    const framesB64: string[] = [];
    for (let i = 0; i < FRAMES; i++) {
      const buf = await canvas.screenshot({
        path: join(outDir, `frame_${String(i).padStart(3, "0")}.png`),
      });
      framesB64.push(buf.toString("base64"));
      await page.waitForTimeout(INTERVAL_MS);
    }

    // --- Assemble an animated GIF for human inspection (best-effort) ---
    const gifPath = join(OUT_ROOT, `${mode}.gif`);
    try {
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-framerate",
          "5",
          "-i",
          join(outDir, "frame_%03d.png"),
          "-vf",
          "scale=480:-1:flags=lanczos",
          gifPath,
        ],
        { stdio: "ignore" },
      );
      expect(existsSync(gifPath), "GIF should be written").toBeTruthy();
      console.log(`  ▶ ${mode}: GIF → ${gifPath}`);
    } catch (err) {
      // ffmpeg missing: leave the PNG sequence + a note rather than failing.
      writeFileSync(
        join(OUT_ROOT, `${mode}.gif.MISSING.txt`),
        `ffmpeg not found; PNG frames are in ${outDir}\n${String(err)}\n`,
      );
      console.warn(`  ! ffmpeg unavailable — wrote PNG frames to ${outDir} instead of a GIF`);
    }

    // --- Automated "is it actually animating?" assertion ---
    const diffs = await pairwiseDiffs(page, framesB64);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const minPair = Math.min(...diffs);
    console.log(
      `  ▶ ${mode}: mean abs frame diff ${(mean * 100).toFixed(3)}%, min pair ${(minPair * 100).toFixed(3)}%`,
    );
    // Healthy average motion across the run, and no single frozen pair (a frozen
    // canvas reads exactly 0; any real motion clears this comfortably).
    expect(mean, "average inter-frame change too low — canvas may be static").toBeGreaterThan(0.005);
    expect(minPair, "a consecutive frame pair was identical — canvas froze").toBeGreaterThan(0.0003);
  });
}
