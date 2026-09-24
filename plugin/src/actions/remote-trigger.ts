import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { playKey, remoteKey, type PlayView } from "../render.js";
import type { RemoteTriggerSettings } from "../settings.js";

const TIMEOUT_MS = 5000;
/** How often a "Play a key" Remote Trigger re-fetches the target's state to mirror its countdown and ring. */
const POLL_MS = 1000;

interface ApiResult {
  ok: boolean;
  error?: string;
  keys?: { ctx: string; label: string; group: string }[];
  groups?: string[];
  view?: PlayView;
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
  /** One interval per showing key, only while it targets "Play a key" — mirrors that key's countdown and
   * progress ring here, the same way it would look on the host's own deck. */
  #polls = new Map<string, ReturnType<typeof setInterval>>();

  #image(s: RemoteTriggerSettings): string {
    return remoteKey({ label: s.label?.trim() || s.targetLabel || "Remote", kind: s.kind ?? "play", which: s.which });
  }

  override onWillAppear(ev: WillAppearEvent<RemoteTriggerSettings>): void {
    if (!ev.action.isKey()) return;
    void ev.action.setImage(this.#image(ev.payload.settings));
    this.#restartPoll(ev.action, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<RemoteTriggerSettings>): void {
    this.#stopPoll(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<RemoteTriggerSettings>): void {
    if (!ev.action.isKey()) return;
    void ev.action.setImage(this.#image(ev.payload.settings));
    this.#restartPoll(ev.action, ev.payload.settings);
  }

  #stopPoll(id: string): void {
    const t = this.#polls.get(id);
    if (t) { clearInterval(t); this.#polls.delete(id); }
  }

  #restartPoll(key: KeyAction<RemoteTriggerSettings>, s: RemoteTriggerSettings): void {
    this.#stopPoll(key.id);
    if ((s.kind ?? "play") !== "play" || !s.host || !s.key || !s.targetCtx) return;
    const { host, port, key: passphrase, targetCtx } = s;
    const poll = async () => {
      const result = await call(host, port ?? 0, passphrase!, `/v1/status?ctx=${encodeURIComponent(targetCtx!)}`);
      void key.setImage(result.ok && result.view ? playKey(result.view) : this.#image(s));
    };
    void poll();
    this.#polls.set(key.id, setInterval(() => void poll(), POLL_MS));
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
