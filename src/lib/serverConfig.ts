import { createSignal } from "solid-js";

export interface ServerConfig {
  // False when the app is served as a plain static bundle with no backend of
  // ours behind it — then there's nobody to ask about uploads or updates.
  backend: boolean;
  proxyMode: boolean;
  uploadEnabled: boolean;
  linkPreviews?: boolean;
  // The commit this build came from, when the image recorded one.
  commit?: string;
  // Whether the server can apply an update itself, or can only report that one
  // is available and leave the admin to run the updater.
  canSelfUpdate?: boolean;
}

const [config, setConfig] = createSignal<ServerConfig | null>(null);

export function serverConfig(): ServerConfig | null {
  return config();
}

export function proxyMode(): boolean {
  return config()?.proxyMode ?? false;
}

export function uploadEnabled(): boolean {
  return config()?.uploadEnabled ?? false;
}

// Whether this app is served by our own backend at all. Static hosting has
// nobody to ask about uploads or updates.
export function hasBackend(): boolean {
  return config()?.backend ?? false;
}

export function canSelfUpdate(): boolean {
  return config()?.canSelfUpdate ?? false;
}

// Called once on boot. Fetches /api/config from the backend (if present).
// Resolves immediately regardless of success — direct mode is the safe default.
export async function loadServerConfig(): Promise<void> {
  try {
    const res = await fetch("/api/config", { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = (await res.json()) as Omit<ServerConfig, "backend">;
      setConfig({ ...data, backend: true });
      return;
    }
  } catch {
    // Backend not present — direct mode
  }
  setConfig({ backend: false, proxyMode: false, uploadEnabled: false });
}
