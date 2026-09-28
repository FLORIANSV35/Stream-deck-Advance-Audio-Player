import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Engine } from "./engine.js";
import { pickAudioFile } from "./filepicker.js";
import { mixer } from "./mixer.js";
import { outputItems } from "./outputs.js";
import type { Player } from "./player.js";
import type { PlaySettings } from "./settings.js";
import type { Store } from "./store.js";
import type { Updater } from "./updater.js";

const AUDIO_EXT = new Set([".wav", ".mp3", ".aif", ".aiff", ".m4a", ".aac", ".flac", ".caf", ".mp4"]);
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * The web page that configures every sound (files, tracks, trim/loop, waveform, routing, groups) — the only
 * settings UI this module has, since Companion actions only offer plain fields (see companion/HELP.md). Bound to
 * 127.0.0.1 only, with a random per-launch token in the path, the same defense the Stream Deck plugin's own large
 * editor uses (plugin/src/editor-server.ts) — any other page open in the same browser must not be able to guess
 * the URL or make cross-origin requests to it.
 */
export class EditorServer {
  readonly #engine: Engine;
  readonly #store: Store;
  readonly #player: Player;
  readonly #updater: Updater;
  readonly #webDir: string;
  readonly #uploadsDir: string;
  readonly #token = randomBytes(16).toString("hex");
  #server?: Server;
  #wss?: WebSocketServer;
  #port = 0;

  constructor(engine: Engine, store: Store, player: Player, updater: Updater, webDir: string, uploadsDir: string) {
    this.#engine = engine;
    this.#store = store;
    this.#player = player;
    this.#updater = updater;
    this.#webDir = webDir;
    this.#uploadsDir = uploadsDir;
    player.on("position", (soundId, track, playing, pos, dur) => this.#broadcast({ event: "position", soundId, track, playing, pos, dur }));
    player.on("changed", (soundId) => this.#broadcast({ event: "changed", soundId, playing: player.isPlaying(soundId) }));
    mixer.on("change", (target) => this.#broadcast({ event: "mixerChanged", target, level: mixer.level(target) }));
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.#http(req, res));
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (req, socket, head) => {
        const token = (req.url ?? "").split("/").filter(Boolean)[0] ?? "";
        if (!this.#allowedHost(req) || !this.#allowedOrigin(req) || !this.#tokenOk(token)) return void socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => this.#connection(ws));
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.#port = (server.address() as AddressInfo).port;
        this.#server = server;
        this.#wss = wss;
        resolve(this.#port);
      });
    });
  }

  close(): void {
    this.#wss?.close();
    this.#server?.close();
  }

  /** The one URL to open — put in the module's status text and log. */
  url(): string {
    return `http://127.0.0.1:${this.#port}/${this.#token}/`;
  }

  /** Opens the editor in the system's default browser — the "Open Sound Editor" action's whole job, since
   * Companion's own UI otherwise only ever shows this URL as plain status text. */
  open(): void {
    const url = this.url();
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["open", [url]];
    execFile(cmd, args, () => {});
  }

  #allowedHost(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return host === `127.0.0.1:${this.#port}` || host === `localhost:${this.#port}`;
  }

  #allowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return !origin || origin === `http://127.0.0.1:${this.#port}` || origin === `http://localhost:${this.#port}`;
  }

  #tokenOk(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.#token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  #json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  async #http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#allowedHost(req)) return this.#json(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.#port}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const [token, ...rest] = parts;
    if (!token || !this.#tokenOk(token)) return this.#json(res, 404, { error: "invalid token" });
    try {
      if (rest[0] === "api") return await this.#api(req, res, url, rest.slice(1));
      const name = rest.length === 0 ? "index.html" : rest.join("/");
      if (!/^[\w.-]+$/.test(name)) return this.#json(res, 404, { error: "not found" });
      const type = TYPES[extname(name)];
      if (!type) return this.#json(res, 404, { error: "not found" });
      const file = await readFile(join(this.#webDir, name));
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(file);
    } catch (e) {
      // distinct from the plain 404s above: this is the file actually failing to read (wrong webDir, permission
      // issue, packaging bug — see main.ts's findPackageRoot) rather than a simple "no such route"
      this.#json(res, 404, { error: `file read failed: ${(e as Error).message}` });
    }
  }

  async #body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async #api(req: IncomingMessage, res: ServerResponse, url: URL, path: string[]): Promise<void> {
    if (path[0] === "sounds" && req.method === "GET" && path.length === 1) {
      return this.#json(res, 200, this.#store.sounds());
    }
    if (path[0] === "sounds" && path.length === 2 && req.method === "PUT") {
      const id = decodeURIComponent(path[1]);
      const settings = JSON.parse((await this.#body(req)).toString("utf8") || "{}") as PlaySettings;
      this.#store.setSound(id, settings);
      this.#player.settingsChanged(id, settings);
      this.#broadcast({ event: "settings", soundId: id, settings });
      return this.#json(res, 200, { ok: true });
    }
    if (path[0] === "sounds" && path.length === 2 && req.method === "DELETE") {
      const id = decodeURIComponent(path[1]);
      this.#player.stop(id);
      this.#store.deleteSound(id);
      this.#broadcast({ event: "deleted", soundId: id });
      return this.#json(res, 200, { ok: true });
    }
    if (path[0] === "browse" && req.method === "POST") {
      const path_ = await pickAudioFile();
      return this.#json(res, 200, path_ ? { path: path_ } : { error: "cancelled" });
    }
    if (path[0] === "upload" && req.method === "POST") {
      return this.#upload(req, res, url);
    }
    if (path[0] === "peaks" && req.method === "POST") {
      const { file, n, from, to } = JSON.parse((await this.#body(req)).toString("utf8") || "{}");
      const r = file ? await this.#engine.peaks(file, n || 600, from || 0, to || 0) : undefined;
      return this.#json(res, 200, r ?? { error: "Unreadable file" });
    }
    if (path[0] === "outputs" && req.method === "GET") {
      return this.#json(res, 200, outputItems(await this.#engine.devices()));
    }
    if (path[0] === "groups" && req.method === "GET") {
      return this.#json(res, 200, mixer.groups());
    }
    if (path[0] === "mixer" && req.method === "GET" && path.length === 1) {
      const targets = ["*", ...mixer.groups()];
      return this.#json(res, 200, Object.fromEntries(targets.map((t) => [t, mixer.level(t)])));
    }
    if (path[0] === "mixer" && path.length === 2 && req.method === "PUT") {
      const target = decodeURIComponent(path[1]);
      const patch = JSON.parse((await this.#body(req)).toString("utf8") || "{}");
      mixer.set(target, patch);
      return this.#json(res, 200, mixer.level(target));
    }
    if (path[0] === "update" && req.method === "GET") {
      return this.#json(res, 200, await this.#updater.state());
    }
    if (path[0] === "update" && req.method === "PUT") {
      const { enabled } = JSON.parse((await this.#body(req)).toString("utf8") || "{}");
      this.#updater.setEnabled(!!enabled);
      return this.#json(res, 200, await this.#updater.state());
    }
    this.#json(res, 404, { error: "not found" });
  }

  async #upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const rawName = basename(url.searchParams.get("name") ?? "");
    const ext = extname(rawName).toLowerCase();
    if (!rawName || !AUDIO_EXT.has(ext)) return this.#json(res, 415, { error: "Not a recognized audio file type" });
    const body = await this.#body(req);
    if (body.length > MAX_UPLOAD_BYTES) return this.#json(res, 413, { error: "File too large" });
    await mkdir(this.#uploadsDir, { recursive: true });
    const stem = basename(rawName, ext).replace(/[\\/]/g, "_") || "audio";
    let dest = join(this.#uploadsDir, `${stem}${ext}`);
    for (let n = 2; existsSync(dest); n++) dest = join(this.#uploadsDir, `${stem} (${n})${ext}`);
    await writeFile(dest, body);
    this.#json(res, 200, { path: dest });
  }

  #sockets = new Set<WebSocket>();

  #connection(ws: WebSocket): void {
    this.#sockets.add(ws);
    ws.on("close", () => this.#sockets.delete(ws));
  }

  #broadcast(payload: object): void {
    const data = JSON.stringify(payload);
    for (const ws of this.#sockets) if (ws.readyState === ws.OPEN) ws.send(data);
  }
}
