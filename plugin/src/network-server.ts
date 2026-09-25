import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import streamDeck from "@elgato/streamdeck";
import { playAction } from "./actions/play.js";
import { mixer } from "./mixer.js";
import {
  runExitLoop, runSetLoopPoint, runSkip, runStopAll, runVolume,
} from "./remote-actions.js";
import type {
  ExitLoopSettings, SeekSettings, SetLoopPointSettings, StopAllSettings, VolumeSettings,
} from "./settings.js";

const DEFAULT_PORT = 57991;

interface TriggerBody {
  kind?: string;
  ctx?: string;
  [key: string]: unknown;
}

/** Non-internal, non-loopback IPv4 addresses of this machine — shown in the settings panel so the other
 * computer's Remote Trigger key knows what to type in as "Host". */
function localAddresses(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) if (info.family === "IPv4" && !info.internal) out.push(info.address);
  }
  return out;
}

/**
 * Lets another computer's SAAP Audio (a Remote Trigger key) start a Play key or run a group control here, over
 * the local network. Off by default; only starts listening once both "enabled" and a passphrase are set, and
 * every request must present it (`Authorization: Bearer <passphrase>`, compared in constant time). Bound to all
 * interfaces (0.0.0.0), unlike the large editor's server, which is deliberately 127.0.0.1-only.
 */
class NetworkControl {
  #server?: Server;
  #port = 0;

  get enabled(): boolean {
    return mixer.pref("networkEnabled", false);
  }

  get key(): string {
    return mixer.pref("networkKey", "");
  }

  get port(): number {
    return mixer.pref("networkPort", DEFAULT_PORT);
  }

  setEnabled(v: boolean): void {
    mixer.setPref("networkEnabled", v);
    this.#apply();
  }

  setKey(v: string): void {
    mixer.setPref("networkKey", v);
    this.#apply();
  }

  setPort(v: number): void {
    mixer.setPref("networkPort", Math.max(1, Math.min(65535, Math.round(v) || DEFAULT_PORT)));
    this.#apply();
  }

  start(): void {
    this.#apply();
  }

  state(): { enabled: boolean; hasKey: boolean; port: number; listening: boolean; addresses: string[] } {
    return { enabled: this.enabled, hasKey: !!this.key, port: this.port, listening: !!this.#server, addresses: localAddresses() };
  }

  #apply(): void {
    const shouldRun = this.enabled && !!this.key;
    if (this.#server && (!shouldRun || this.#port !== this.port)) {
      this.#server.close();
      this.#server = undefined;
    }
    if (shouldRun && !this.#server) {
      this.#port = this.port;
      const server = createServer((req, res) => void this.#handle(req, res));
      server.on("error", (e) => streamDeck.logger.error(`Network control: ${e.message}`));
      server.listen(this.#port, "0.0.0.0");
      this.#server = server;
    }
  }

  #authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expected = this.key;
    if (!expected || !presented) return false;
    const a = Buffer.from(presented), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: object) => {
      const data = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
      res.end(data);
    };
    if (!this.#authorized(req)) return send(401, { ok: false, error: "Unauthorized" });
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/v1/keys") {
        return send(200, { ok: true, keys: playAction?.listKeys() ?? [] });
      }
      if (req.method === "GET" && url.pathname === "/v1/groups") {
        return send(200, { ok: true, groups: mixer.groups() });
      }
      if (req.method === "GET" && url.pathname === "/v1/status") {
        const ctx = url.searchParams.get("ctx") ?? "";
        const view = playAction?.viewOf(ctx);
        return send(200, view ? { ok: true, view } : { ok: false, error: "Key not found (is it showing on a deck?)" });
      }
      if (req.method === "POST" && url.pathname === "/v1/trigger") {
        const body = await this.#json(req);
        return send(200, await this.#trigger(body));
      }
      send(404, { ok: false, error: "Not found" });
    } catch (e) {
      send(500, { ok: false, error: (e as Error).message });
    }
  }

  #json(req: IncomingMessage): Promise<TriggerBody> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 64 * 1024) { reject(new Error("Payload too large")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); } });
      req.on("error", reject);
    });
  }

  async #trigger(body: TriggerBody): Promise<object> {
    switch (body.kind) {
      case "play": {
        const ctx = typeof body.ctx === "string" ? body.ctx : "";
        const ok = playAction?.triggerRemote(ctx) ?? false;
        return { ok, error: ok ? undefined : "Key not found (is it showing on a deck?)" };
      }
      case "volume":
        runVolume(body as VolumeSettings);
        return { ok: true };
      case "skip":
        runSkip(body as SeekSettings);
        return { ok: true };
      case "stopAll":
        runStopAll(body as StopAllSettings);
        return { ok: true };
      case "exitLoop":
        runExitLoop(body as ExitLoopSettings);
        return { ok: true };
      case "loopPoint": {
        const matched = await runSetLoopPoint(body as SetLoopPointSettings);
        return { ok: matched };
      }
      default:
        return { ok: false, error: `Unknown kind: ${String(body.kind)}` };
    }
  }
}

export const networkControl = new NetworkControl();
