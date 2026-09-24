import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

/** What the editor needs to know about a key, and how it reaches the plugin's own logic. */
export interface EditorHost {
  /** The key's current state, or undefined if it is no longer known (deleted, or its page is not showing). */
  session(ctx: string): { action: string; device: string; settings: object; coordinates?: object } | undefined;
  /** The page changed the key's settings. `origin` is the socket that sent them (not to be echoed back to it). */
  setSettings(ctx: string, settings: object, origin: WebSocket): Promise<void>;
  /** A "sendToPlugin" message from the page; `reply` answers it like `sendToPropertyInspector` would. */
  message(ctx: string, payload: object, reply: (payload: object) => void): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * A large settings page for a Play key, opened in the user's browser. It serves the real inspector page (`play.html`)
 * and speaks the same WebSocket protocol as Stream Deck's property inspector — so every setting works exactly as it
 * does in the app's own panel. Bound to 127.0.0.1 only; a random token per launch guards the page and the socket
 * (any other web page in the browser cannot guess it, and the Host / Origin headers are checked against rebinding).
 */
export class EditorServer {
  readonly #host: EditorHost;
  readonly #uiDir: string;
  readonly #token = randomBytes(16).toString("hex");
  #server?: Server;
  #wss?: WebSocketServer;
  #port = 0;
  #starting?: Promise<void>;
  #sockets = new Map<WebSocket, { ctx: string; uuid: string }>();

  constructor(host: EditorHost, uiDir: string) {
    this.#host = host;
    this.#uiDir = uiDir;
  }

  /** URL of the editor page for a key, starting the server on first use. */
  async url(ctx: string): Promise<string> {
    await (this.#starting ??= this.#start());
    return `http://127.0.0.1:${this.#port}/${this.#token}/popup?ctx=${encodeURIComponent(ctx)}`;
  }

  /** Sends new settings to every editor page open on this key (except the one that just made the change). */
  push(ctx: string, settings: object, except?: WebSocket): void {
    for (const [ws, s] of this.#sockets) {
      if (s.ctx === ctx && ws !== except) this.#sendSettings(ws, s.ctx, s.uuid, settings);
    }
  }

  close(): void {
    this.#wss?.close();
    this.#server?.close();
  }

  #start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.#http(req, res));
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (req, socket, head) => {
        if (!this.#allowedHost(req) || !this.#allowedOrigin(req)) return void socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => this.#connection(ws));
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.#port = (server.address() as AddressInfo).port;
        this.#server = server;
        this.#wss = wss;
        resolve();
      });
    });
  }

  #allowedHost(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return host === `127.0.0.1:${this.#port}` || host === `localhost:${this.#port}`;
  }

  #allowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return origin === `http://127.0.0.1:${this.#port}` || origin === `http://localhost:${this.#port}`;
  }

  #tokenOk(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.#token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async #http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (code: number) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(); };
    if (req.method !== "GET" || !this.#allowedHost(req)) return fail(403);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.#port}`);
    const [, token, name, ...rest] = url.pathname.split("/");
    if (!token || !this.#tokenOk(token) || !name || rest.length > 0) return fail(404);
    try {
      if (name === "popup") {
        const ctx = url.searchParams.get("ctx") ?? "";
        const session = this.#host.session(ctx);
        if (!session) return fail(410);
        const page = await this.#page(ctx, session);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page);
        return;
      }
      const type = TYPES[/\.[a-z]+$/.exec(name)?.[0] ?? ""];
      if (!type || !/^[\w.-]+$/.test(name)) return fail(404);
      const file = await readFile(join(this.#uiDir, name));
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(file);
    } catch {
      fail(404);
    }
  }

  /** `play.html` adapted to a browser tab: larger layout, all tracks open, a real path field in place of the file picker. */
  async #page(ctx: string, session: NonNullable<ReturnType<EditorHost["session"]>>): Promise<string> {
    let html = await readFile(join(this.#uiDir, "play.html"), "utf8");
    html = html
      .replace(/<!--wide-btn-->[\s\S]*?<!--\/wide-btn-->/, "")
      // a browser's file picker only reveals the file *name*: use a path field + a native dialog opened by the plugin
      .replace(
        /<sdpi-file setting="(\w+)"[^>]*><\/sdpi-file>/g,
        '<div class="filerow"><sdpi-textfield setting="$1" placeholder="Path to an audio file"></sdpi-textfield>' +
          '<button type="button" class="browse" data-setting="$1">Browse…</button></div>',
      )
      .replace(/<details class="card /g, '<details open class="card ')
      .replace("</head>", '  <link rel="stylesheet" href="popup.css" />\n</head>')
      .replace("<body>", '<body class="popup">');
    const uuid = `${this.#token}:${ctx}`;
    const config = {
      port: this.#port,
      uuid,
      info: { application: { language: "en", platform: process.platform === "win32" ? "windows" : "mac", version: "6.5" }, devicePixelRatio: 1 },
      actionInfo: {
        action: session.action, context: uuid, device: session.device,
        payload: { settings: session.settings, coordinates: session.coordinates ?? { column: 0, row: 0 }, controller: "Keypad", isInMultiAction: false },
      },
    };
    const json = JSON.stringify(config).replace(/</g, "\\u003c");
    return html.replace("</body>", `<script>window.SAAP_EDITOR = ${json};</script>\n<script src="popup.js"></script>\n</body>`);
  }

  #sendSettings(ws: WebSocket, ctx: string, uuid: string, settings: object): void {
    const session = this.#host.session(ctx);
    if (!session) return;
    this.#send(ws, {
      event: "didReceiveSettings", action: session.action, context: uuid, device: session.device,
      payload: { settings, coordinates: session.coordinates ?? { column: 0, row: 0 }, isInMultiAction: false },
    });
  }

  #send(ws: WebSocket, msg: object): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  #connection(ws: WebSocket): void {
    ws.on("close", () => this.#sockets.delete(ws));
    ws.on("message", (data) => {
      let msg: { event?: string; uuid?: string; context?: string; payload?: unknown; action?: string };
      try { msg = JSON.parse(data.toString()); } catch { return ws.close(); }
      const known = this.#sockets.get(ws);
      if (!known) {
        // the first message registers the page: its uuid is "<token>:<key context>"
        const [token, ...ctx] = String(msg.uuid ?? "").split(":");
        if (msg.event !== "registerPropertyInspector" || !this.#tokenOk(token) || !this.#host.session(ctx.join(":"))) return ws.close();
        this.#sockets.set(ws, { ctx: ctx.join(":"), uuid: msg.uuid! });
        return;
      }
      if (msg.context !== known.uuid) return;
      const session = this.#host.session(known.ctx);
      if (!session) return;
      switch (msg.event) {
        case "getSettings":
          this.#sendSettings(ws, known.ctx, known.uuid, session.settings);
          break;
        case "getGlobalSettings":
          this.#send(ws, { event: "didReceiveGlobalSettings", payload: { settings: {} } });
          break;
        case "setSettings":
          if (msg.payload && typeof msg.payload === "object") void this.#host.setSettings(known.ctx, msg.payload, ws);
          break;
        case "sendToPlugin":
          if (msg.payload && typeof msg.payload === "object") {
            void this.#host.message(known.ctx, msg.payload, (payload) =>
              this.#send(ws, { event: "sendToPropertyInspector", action: session.action, context: known.uuid, payload }));
          }
          break;
      }
    });
  }
}
