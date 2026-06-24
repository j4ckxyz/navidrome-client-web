// "Classic" mode — a G-Force / iTunes-Visualizer-style flowing plasma. A coarse
// sine-field plasma is computed on a small offscreen buffer (cheap: a few
// thousand pixels), palette-cycled through the cover colours, and scaled up with
// smoothing for the soft, liquid look. Overall amplitude warps the field, the
// three bands push the colour bands around, and each beat blooms a bright blob.

import {
  colorAt,
  hslToRgb,
  rgba,
  type RGB,
  type RenderContext,
  type VizRenderer,
} from "./renderer";

interface Blob {
  x: number; // 0..1 of width
  y: number; // 0..1 of height
  vx: number;
  vy: number;
  life: number; // 1 → 0
  hue: number;
  band: number; // which band spawned it (for colour bias)
}

export class ClassicRenderer implements VizRenderer {
  readonly id = "classic";
  readonly label = "Classic";

  private buf: HTMLCanvasElement | OffscreenCanvas;
  private bctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private img: ImageData;
  private bw = 0;
  private bh = 0;
  private quality = 1;
  private width = 0;
  private height = 0;
  private blobs: Blob[] = [];
  private hueDrift = 0;
  private beatCooldown = 0;

  constructor() {
    const { canvas, ctx } = makeBuffer(160, 90);
    this.buf = canvas;
    this.bctx = ctx;
    this.img = ctx.createImageData(160, 90);
    this.bw = 160;
    this.bh = 90;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.sizeBuffer();
  }

  // The plasma buffer scales with the quality budget: ~140px wide at full
  // quality, dropping toward 64px on slow hardware. Aspect follows the stage.
  private sizeBuffer(): void {
    const targetW = Math.round(64 + 96 * this.quality);
    const aspect = this.height > 0 ? this.height / this.width : 9 / 16;
    const bw = Math.max(48, targetW);
    const bh = Math.max(32, Math.round(bw * aspect));
    if (bw === this.bw && bh === this.bh) return;
    this.bw = bw;
    this.bh = bh;
    this.buf.width = bw;
    this.buf.height = bh;
    this.img = this.bctx.createImageData(bw, bh);
  }

  draw(rc: RenderContext): void {
    const { ctx, width, height, time } = rc;
    if (rc.quality !== this.quality) {
      this.quality = rc.quality;
      this.sizeBuffer();
    }
    this.renderPlasma(rc, time);

    // Scale the plasma buffer up across the whole stage; smoothing gives the
    // soft, liquid gradients that define the look.
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = 1;
    ctx.drawImage(this.buf as CanvasImageSource, 0, 0, width, height);
    ctx.restore();

    this.renderBlobs(rc);

    // A soft vignette to seat the plasma and keep the edges from feeling flat.
    const vg = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.2,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.75,
    );
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, width, height);
  }

  // Compute the plasma into the offscreen ImageData. Classic layered sine fields,
  // with frequency content kneading the field and the palette cycling over time.
  private renderPlasma(rc: RenderContext, time: number): void {
    const { palette, frame } = rc;
    const data = this.img.data;
    const w = this.bw;
    const h = this.bh;

    // Bands warp the field; amplitude sets overall contrast/turbulence.
    const warp = 1 + frame.amplitude * 1.6 + frame.bass * 1.2;
    const t = time * (0.4 + frame.mid * 0.8);
    this.hueDrift += (0.02 + frame.treble * 0.12) * rc.dt;

    const sx = 6.0 * warp;
    const sy = 5.0 * warp;

    let p = 0;
    for (let yi = 0; yi < h; yi++) {
      const ny = yi / h;
      for (let xi = 0; xi < w; xi++) {
        const nx = xi / w;
        // Layered sines = the canonical plasma field, 0..1.
        let v =
          Math.sin(nx * sx + t * 1.3) +
          Math.sin(sy * (ny + Math.sin(t * 0.5) * 0.3) + t) +
          Math.sin((nx + ny) * 4.0 * warp + t * 1.7) +
          Math.sin(Math.hypot(nx - 0.5, ny - 0.5) * 12.0 - t * 2.0);
        v = (v + 4) / 8; // → 0..1

        // Map the field through the cover palette, then tint with a slow hue
        // drift driven by treble so it shimmers without leaving the album mood.
        const base = colorAt(palette, v);
        const shimmer = hslToRgb(this.hueDrift + v * 0.25, 0.6, 0.5);
        const k = 0.25 + frame.treble * 0.25;
        const r = base.r * (1 - k) + shimmer.r * k;
        const g = base.g * (1 - k) + shimmer.g * k;
        const b = base.b * (1 - k) + shimmer.b * k;

        // Bass lifts brightness so drops bloom the whole field.
        const bright = 0.55 + 0.45 * v + frame.bass * 0.35;
        data[p++] = Math.min(255, r * bright);
        data[p++] = Math.min(255, g * bright);
        data[p++] = Math.min(255, b * bright);
        data[p++] = 255;
      }
    }
    this.bctx.putImageData(this.img, 0, 0);
  }

  // Bright additive blobs spawned on beats — the energetic "pop" over the plasma.
  private renderBlobs(rc: RenderContext): void {
    const { ctx, width, height, frame, palette } = rc;

    this.beatCooldown -= rc.dt;
    if (frame.beat > 0.45 && this.beatCooldown <= 0 && this.blobs.length < 24) {
      // Spawn a small cluster of blobs biased to wherever the energy is.
      const band = frame.bass > frame.treble ? 0 : frame.treble > frame.mid ? 2 : 1;
      const count = 1 + Math.round(frame.beat * 2);
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = 0.05 + Math.random() * 0.12;
        this.blobs.push({
          x: 0.5 + (Math.random() - 0.5) * 0.3,
          y: 0.5 + (Math.random() - 0.5) * 0.3,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          life: 1,
          hue: Math.random(),
          band,
        });
      }
      this.beatCooldown = 0.08;
    }

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const b of this.blobs) {
      b.x += b.vx * rc.dt;
      b.y += b.vy * rc.dt;
      b.vx *= 0.985;
      b.vy *= 0.985;
      b.life -= rc.dt * 0.9;
      if (b.life <= 0) continue;
      const energy = b.band === 0 ? frame.bass : b.band === 1 ? frame.mid : frame.treble;
      const radius = Math.min(width, height) * (0.04 + b.life * 0.12 + energy * 0.06);
      const cx = b.x * width;
      const cy = b.y * height;
      const col: RGB = colorAt(palette, b.band / 2);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, rgba(col, 0.5 * b.life));
      grad.addColorStop(0.4, rgba(col, 0.18 * b.life));
      grad.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    this.blobs = this.blobs.filter((b) => b.life > 0);
  }
}

// A buffer canvas: OffscreenCanvas where available, else a detached <canvas>.
function makeBuffer(
  w: number,
  h: number,
): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) return { canvas, ctx: ctx as OffscreenCanvasRenderingContext2D };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return { canvas, ctx };
}
