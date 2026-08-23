// Minimal browser surface the app modules touch at import time and while the
// player runs headless. Installed before any app import.

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

// A stand-in for HTMLAudioElement: enough of the surface for AudioEngine to
// construct its two decks and be driven, with no real decoding.
class FakeAudio {
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  src = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = NaN;
  paused = true;
  crossOrigin: string | null = null;
  error: { code: number } | null = null;
  playbackRate = 1;
  addEventListener(type: string, fn: (e: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type });
  }
  play(): Promise<void> {
    this.paused = false;
    this.dispatch("playing");
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.dispatch("pause");
  }
  load(): void {}
  removeAttribute(): void {}
  setAttribute(): void {}
  canPlayType(): string {
    return "probably";
  }
}

export function installShims(): void {
  const g = globalThis as Record<string, unknown>;
  g.localStorage = new MemoryStorage();
  g.sessionStorage = new MemoryStorage();
  g.Audio = FakeAudio;
  g.performance ??= { now: () => Date.now() };

  const listeners = new Map<string, Set<(e: unknown) => void>>();
  g.window = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (e: { type: string }) => {
      for (const fn of listeners.get(e.type) ?? []) fn(e);
      return true;
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    location: { origin: "http://localhost", href: "http://localhost/" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    navigator: { userAgent: "harness" },
  };
  g.document = {
    createElement: () => new FakeAudio(),
    documentElement: { classList: { add() {}, remove() {} }, style: { setProperty() {} } },
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
  };
  g.navigator ??= { userAgent: "harness", mediaSession: undefined };
  g.requestAnimationFrame = (fn: (t: number) => void) =>
    setTimeout(() => fn(Date.now()), 16) as unknown as number;
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
