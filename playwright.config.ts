import { defineConfig, devices } from "@playwright/test";

// Visual smoke tests for the music visualiser. They drive the dev server's
// /viz-harness.html page, which plays a synthetic signal through the real audio
// analysis + render pipeline. See e2e/README.md for how to run and where the
// generated GIFs land.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    // Capture actual compositor output; the visualiser is a canvas.
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          // Let the harness start audio + AudioContext without a user gesture,
          // so the real <audio> → AnalyserNode path runs under automation.
          args: ["--autoplay-policy=no-user-gesture-required"],
        },
      },
    },
  ],
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5173/viz-harness.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
