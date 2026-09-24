import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { remoteKey } from "../render.js";
import type { RemoteTriggerSettings } from "../settings.js";

const TIMEOUT_MS = 5000;

interface ApiResult {
  ok: boolean;
  error?: string;
  keys?: { ctx: string; label: string; group: string }[];
  groups?: string[];
}

async function call(host: string, port: number, key: string, path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult> {
  if (!host || !key) return { ok: false, error: "Host and passphrase are required" };
  try {
    const res = await fetch(`http://${host}:${port || 57991}${path}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${key}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as ApiResult;
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return body;
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    if (err.name === "TimeoutError") return { ok: false, error: "Timed out — check the address and that the host has network control enabled" };
    return { ok: false, error: err.cause?.message ?? err.message };
  }
}

/** Triggers a Play key, or a group control (Volume, Skip, Stop all, Exit loop, Set loop point), on another
 * computer's SAAP Audio over the network (see network-server.ts on the host side). */
@action({ UUID: "com.saap.audio.remote" })
export class RemoteTriggerAction extends SingletonAction<RemoteTriggerSettings> {
  #image(s: RemoteTriggerSettings): string {
    return remoteKey({ label: s.label?.trim() || s.targetLabel || "Remote", kind: s.kind ?? "play", which: s.which });
  }

  override onWillAppear(ev: WillAppearEvent<RemoteTriggerSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(this.#image(ev.payload.settings));
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<RemoteTriggerSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(this.#image(ev.payload.settings));
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, RemoteTriggerSettings>): Promise<void> {
    const payload = ev.payload as { event?: string; host?: string; port?: number; key?: string };
    if (payload.event !== "testConnection") return;
    const host = payload.host ?? "", port = payload.port ?? 0, key = payload.key ?? "";
    const [keys, groups] = await Promise.all([
      call(host, port, key, "/v1/keys"),
      call(host, port, key, "/v1/groups"),
    ]);
    const ok = keys.ok && groups.ok;
    await streamDeck.ui.sendToPropertyInspector({
      event: "testResult", ok, error: ok ? undefined : (keys.error ?? groups.error),
      keys: keys.keys ?? [], groups: groups.groups ?? [],
    } as JsonValue);
  }

  override async onKeyDown(ev: KeyDownEvent<RemoteTriggerSettings>): Promise<void> {
    const s = ev.payload.settings;
    const host = s.host ?? "", port = s.port ?? 0, key = s.key ?? "";
    const kind = s.kind ?? "play";
    const body: Record<string, unknown> = { kind };
    switch (kind) {
      case "play": body.ctx = s.targetCtx; break;
      case "volume": Object.assign(body, { target: s.target, mode: s.mode, step: s.step, value: s.value }); break;
      case "skip": Object.assign(body, { group: s.group, direction: s.direction, seconds: s.seconds }); break;
      case "stopAll": Object.assign(body, { group: s.group, mode: s.mode, fade: s.fade }); break;
      case "exitLoop": body.group = s.group; break;
      case "loopPoint": Object.assign(body, { group: s.group, which: s.which }); break;
    }
    const result = await call(host, port, key, "/v1/trigger", { method: "POST", body });
    if (result.ok) void ev.action.showOk();
    else {
      void ev.action.showAlert();
      if (result.error) streamDeck.logger.warn(`Remote Trigger: ${result.error}`);
    }
  }
}
