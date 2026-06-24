// "Magnetosphere" mode — a particle system grouped into three clusters, one per
// frequency band (bass / mid / treble). Each cluster has a roaming centre; band
// energy drives attraction/repulsion both within a cluster (particles expand
// outward on energy, collapse when quiet) and between clusters (loud bands shove
// their clusters apart). Particles are drawn as additive, pre-rendered glow
// sprites for a cheap bloom look without WebGL.
//
// Performance: the active particle count scales with the stage's quality budget,
// from ~300 up to ~1000, and glow sprites are blitted (not per-particle
// gradients) so a thousand particles stay affordable on a 2D context.

import { colorAt, lerp, rgba, type RGB, type RenderContext, type VizRenderer } from "./renderer";

const MAX_PARTICLES = 1000;
const CLUSTERS = 3;

interface Cluster {
  x: number; // centre, CSS px
  y: number;
  vx: number;
  vy: number;
  homeAngle: number; // base position around the stage centre
  color: RGB;
  sprite: HTMLCanvasElement | null;
}

export class MagnetosphereRenderer implements VizRenderer {
  readonly id = "magnetosphere";
  readonly label = "Magnetosphere";

  private width = 0;
  private height = 0;
  private quality = 1;
  private active = MAX_PARTICLES;

  // Particle state in flat arrays (no per-particle objects in the hot loop).
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private vx = new Float32Array(MAX_PARTICLES);
  private vy = new Float32Array(MAX_PARTICLES);
  private seed = new Float32Array(MAX_PARTICLES); // per-particle phase 0..1
  private cluster = new Uint8Array(MAX_PARTICLES);

  private clusters: Cluster[] = [];
  private paletteKey = "";
  private started = false;

  resize(width: number, height: number): void {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    if (first || !this.started) this.init();
  }

  setQuality(q: number): void {
    this.quality = q;
    this.active = Math.round(300 + (MAX_PARTICLES - 300) * q);
  }

  private init(): void {
    const cx = this.width / 2;
    const cy = this.height / 2;
    this.clusters = [];
    for (let c = 0; c < CLUSTERS; c++) {
      const a = (c / CLUSTERS) * Math.PI * 2 - Math.PI / 2;
      this.clusters.push({
        x: cx + Math.cos(a) * this.width * 0.15,
        y: cy + Math.sin(a) * this.height * 0.15,
        vx: 0,
        vy: 0,
        homeAngle: a,
        color: { r: 255, g: 255, b: 255 },
        sprite: null,
      });
    }
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const c = i % CLUSTERS;
      this.cluster[i] = c;
      this.seed[i] = Math.random();
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * Math.min(this.width, this.height) * 0.1;
      this.px[i] = this.clusters[c].x + Math.cos(ang) * rad;
      this.py[i] = this.clusters[c].y + Math.sin(ang) * rad;
      this.vx[i] = 0;
      this.vy[i] = 0;
    }
    this.started = true;
  }

  // Re-tint cluster colours + glow sprites when the palette changes.
  private syncPalette(rc: RenderContext): void {
    const key = rc.palette.map((c) => `${c.r | 0},${c.g | 0},${c.b | 0}`).join("|");
    if (key === this.paletteKey && this.clusters.every((c) => c.sprite)) return;
    this.paletteKey = key;
    for (let c = 0; c < CLUSTERS; c++) {
      const col = colorAt(rc.palette, c / (CLUSTERS - 1));
      this.clusters[c].color = col;
      this.clusters[c].sprite = makeGlowSprite(col);
    }
  }

  draw(rc: RenderContext): void {
    const { ctx, width, height, frame, dt } = rc;
    if (rc.quality !== this.quality) this.setQuality(rc.quality);
    if (!this.started) this.init();
    this.syncPalette(rc);

    const bands = [frame.bass, frame.mid, frame.treble];
    const cx = width / 2;
    const cy = height / 2;
    const step = Math.min(dt, 0.05); // clamp so a stutter can't explode forces

    // --- Move cluster centres: spring home + inter-cluster push/pull ---
    for (let c = 0; c < CLUSTERS; c++) {
      const cl = this.clusters[c];
      const energy = bands[c];
      // Loud bands ride further out from centre; quiet ones settle in.
      const orbit = (0.12 + energy * 0.22) * Math.min(width, height);
      const drift = rc.time * (0.25 + c * 0.07);
      const hx = cx + Math.cos(cl.homeAngle + drift) * orbit;
      const hy = cy + Math.sin(cl.homeAngle + drift) * orbit;
      cl.vx += (hx - cl.x) * 2.4 * step;
      cl.vy += (hy - cl.y) * 2.4 * step;

      // Pairwise: combined energy of two clusters repels them apart (the bands
      // "fighting"); a quiet pair drifts gently together.
      for (let d = 0; d < CLUSTERS; d++) {
        if (d === c) continue;
        const other = this.clusters[d];
        let dx = cl.x - other.x;
        let dy = cl.y - other.y;
        const dist = Math.hypot(dx, dy) || 1;
        dx /= dist;
        dy /= dist;
        const combined = bands[c] + bands[d];
        const force = (combined * 9000 - 1500) / dist; // + repel, − attract
        cl.vx += dx * force * step;
        cl.vy += dy * force * step;
      }
      cl.vx *= 0.9;
      cl.vy *= 0.9;
      cl.x += cl.vx * step;
      cl.y += cl.vy * step;
    }

    // --- Integrate particles toward their cluster, expanding with band energy ---
    const reach = Math.min(width, height);
    for (let i = 0; i < this.active; i++) {
      const c = this.cluster[i];
      const cl = this.clusters[c];
      const energy = bands[c];
      // Rest radius grows with energy → attraction at low energy, repulsion
      // (outward push) at high energy, which is the magnetosphere "breathing".
      // The wide per-particle seed spread keeps them a dispersed cloud rather
      // than collapsing onto a single bright ring.
      const rest = reach * (0.05 + energy * 0.22) * (0.25 + this.seed[i] * 1.5);
      let dx = cl.x - this.px[i];
      let dy = cl.y - this.py[i];
      const dist = Math.hypot(dx, dy) || 1;
      dx /= dist;
      dy /= dist;
      const spring = (dist - rest) * 6.0;
      this.vx[i] += dx * spring * step;
      this.vy[i] += dy * spring * step;
      // Tangential swirl, faster with energy, giving the orbital shimmer.
      const swirl = (0.6 + energy * 4.0) * (this.seed[i] < 0.5 ? 1 : -1);
      this.vx[i] += -dy * swirl * step * 12;
      this.vy[i] += dx * swirl * step * 12;
      // Beat impulse: a sharp outward kick scaled by the band.
      if (frame.beat > 0.5) {
        const kick = frame.beat * energy * 60;
        this.vx[i] -= dx * kick * step;
        this.vy[i] -= dy * kick * step;
      }
      this.vx[i] *= 0.92;
      this.vy[i] *= 0.92;
      this.px[i] += this.vx[i] * step;
      this.py[i] += this.vy[i] * step;
    }

    // --- Paint: faint connective haze, then additive glow sprites ---
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Cluster cores as broad soft glows so the structure reads even when sparse.
    for (let c = 0; c < CLUSTERS; c++) {
      const cl = this.clusters[c];
      const r = reach * (0.07 + bands[c] * 0.1);
      const g = ctx.createRadialGradient(cl.x, cl.y, 0, cl.x, cl.y, r);
      g.addColorStop(0, rgba(cl.color, 0.1 + bands[c] * 0.14));
      g.addColorStop(1, rgba(cl.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cl.x, cl.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < this.active; i++) {
      const c = this.cluster[i];
      const cl = this.clusters[c];
      const sprite = cl.sprite;
      if (!sprite) continue;
      const speed = Math.hypot(this.vx[i], this.vy[i]);
      const energy = bands[c];
      // Small sprites + modest alpha: with up to 1000 additive sprites, low
      // per-particle weight keeps the field from blowing out to flat white and
      // lets the individual points read.
      const size = reach * (0.006 + energy * 0.012 + Math.min(speed / 1400, 0.014));
      const alpha = 0.1 + energy * 0.28 + Math.min(speed / 2200, 0.16);
      ctx.globalAlpha = Math.min(0.75, alpha);
      ctx.drawImage(sprite, this.px[i] - size, this.py[i] - size, size * 2, size * 2);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// Pre-render a soft circular glow tinted to `col` once, so the hot loop only
// blits it. Bright core fading to transparent = additive bloom when composited
// with "lighter".
function makeGlowSprite(col: RGB): HTMLCanvasElement {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // A lightly lifted centre keeps the bloom crisp without washing every overlap
  // to pure white once hundreds of sprites stack additively.
  const hot: RGB = { r: lerp(col.r, 255, 0.35), g: lerp(col.g, 255, 0.35), b: lerp(col.b, 255, 0.35) };
  g.addColorStop(0, rgba(hot, 1));
  g.addColorStop(0.3, rgba(col, 0.7));
  g.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}
