import { createSignal } from "solid-js";

export interface ServerConfig {
  proxyMode: boolean;
  uploadEnabled: boolean;
  linkPreviews?: boolean;
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

// Called once on boot. Fetches /api/config from the backend (if present).
// Resolves immediately regardless of success — direct mode is the safe default.
export async function loadServerConfig(): Promise<void> {
  try {
    const res = await fetch("/api/config", { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = (await res.json()) as ServerConfig;
      setConfig(data);
      return;
    }
  } catch {
    // Backend not present — direct mode
  }
  setConfig({ proxyMode: false, uploadEnabled: false });
}
