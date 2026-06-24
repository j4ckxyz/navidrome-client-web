# Visualiser visual smoke tests

A Playwright test that proves the music visualiser actually animates in response
to real audio analysis — and produces GIFs you can eyeball for visual quality.

## What it exercises

It does **not** need a Navidrome server or a real track. Instead it loads
`/viz-harness.html` (a dev-only page, not in the production bundle), which:

- synthesises a signal in-page — an 80 Hz "bass" oscillator amplitude-modulated
  by a slow LFO, a 1 kHz "mid", and a 6 kHz "treble" — and renders it to a WAV
  blob;
- plays that WAV through a **real `<audio>` element** wired to a **real
  `AnalyserNode`** (`fftSize 2048`, `smoothingTimeConstant 0.8`);
- runs the **same** `analysis.ts` + `ClassicMode` / `MagnetosphereMode`
  renderers + `loop.ts` the app uses.

So the genuine end-to-end pipeline is under test; only the audio *source* is a
local synthetic blob instead of a Navidrome stream (which keeps it CORS-clean —
a tainted cross-origin source would blank the analyser).

For each mode it captures the canvas every 200 ms for ~5 s with
`locator.screenshot()` (compositor output — **not** `canvas.toDataURL()`, which
can read back blank), assembles a GIF, and asserts consecutive frames differ by
more than a small pixel threshold (so a frozen canvas fails automatically).

## Run it

```bash
# one-time: install the browser
bunx playwright install chromium

# run the tests (auto-starts `bun run dev` if not already running)
bunx playwright test

# watch it happen in a real browser
bunx playwright test --headed

# just one mode
bunx playwright test -g classic
```

## Output

Generated artifacts land in `test-results/visualiser/`:

- `classic.gif` and `magnetosphere.gif` — the inspectable animations;
- `classic/frame_###.png`, `magnetosphere/frame_###.png` — the raw captured
  frames.

GIF assembly uses `ffmpeg` (`ffmpeg -framerate 5 -i frame_%03d.png -vf
"scale=480:-1:flags=lanczos" out.gif`). If `ffmpeg` isn't on your PATH the test
still passes and leaves the PNG sequence plus a `*.gif.MISSING.txt` note —
install ffmpeg (`brew install ffmpeg`) to get the GIFs.
