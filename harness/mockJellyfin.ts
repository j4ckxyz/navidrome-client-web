// A mock Jellyfin server: the handful of endpoints remote control touches,
// plus the /socket channel, so the real client code runs unmodified against it.

import type { ServerWebSocket } from "bun";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

const TICKS = 10_000_000;

export function makeItem(id: string, title: string, artist: string, seconds: number) {
  return {
    Id: id,
    Name: title,
    Type: "Audio",
    Artists: [artist],
    AlbumArtist: artist,
    Album: "Test Album",
    AlbumId: "album-1",
    RunTimeTicks: seconds * TICKS,
    IndexNumber: 1,
    ProductionYear: 2024,
    ImageTags: { Primary: "tag" },
  };
}

export class MockJellyfin {
  readonly requests: Recorded[] = [];
  sessions: Record<string, unknown>[] = [];
  private sockets = new Set<ServerWebSocket<unknown>>();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private items = new Map<string, ReturnType<typeof makeItem>>();
  socketMessages: { MessageType?: string; Data?: unknown }[] = [];

  addItems(items: ReturnType<typeof makeItem>[]): void {
    for (const item of items) this.items.set(item.Id, item);
  }

  get url(): string {
    return `http://localhost:${this.server!.port}`;
  }

  get socketCount(): number {
    return this.sockets.size;
  }

  start(): void {
    const self = this;
    this.server = Bun.serve({
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/socket") {
          if (server.upgrade(req)) return undefined;
          return new Response("expected websocket", { status: 400 });
        }
        return self.handle(req, url);
      },
      websocket: {
        open(ws) {
          self.sockets.add(ws);
        },
        message(_ws, message) {
          try {
            self.socketMessages.push(JSON.parse(String(message)));
          } catch {
            // ignore
          }
        },
        close(ws) {
          self.sockets.delete(ws);
        },
      },
    });
  }

  stop(): void {
    for (const ws of this.sockets) ws.close();
    this.server?.stop(true);
  }

  // Push a Sessions payload down every open socket, as the real server does
  // once SessionsStart has been sent.
  pushSessions(sessions?: Record<string, unknown>[]): void {
    if (sessions) this.sessions = sessions;
    const frame = JSON.stringify({ MessageType: "Sessions", Data: this.sessions });
    for (const ws of this.sockets) ws.send(frame);
  }

  push(messageType: string, data: unknown): void {
    const frame = JSON.stringify({ MessageType: messageType, Data: data });
    for (const ws of this.sockets) ws.send(frame);
  }

  private async handle(req: Request, url: URL): Promise<Response> {
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    let body: unknown = undefined;
    if (req.method !== "GET") {
      const text = await req.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    }
    this.requests.push({ method: req.method, path: url.pathname, query, body });

    if (url.pathname === "/Sessions" && req.method === "GET") {
      return Response.json(this.sessions);
    }
    if (url.pathname === "/Items" && req.method === "GET" && query.ids) {
      // Jellyfin returns items in its own order, not the order asked for —
      // reversed here so the client's re-keying is actually exercised.
      const found = query.ids
        .split(",")
        .map((id) => this.items.get(id))
        .filter(Boolean)
        .reverse();
      return Response.json({ Items: found, TotalRecordCount: found.length });
    }
    // Everything else (capabilities, session commands, playback reports).
    return new Response(null, { status: 204 });
  }

  find(method: string, pathPrefix: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  clear(): void {
    this.requests.length = 0;
    this.socketMessages.length = 0;
  }
}
