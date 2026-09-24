import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
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
import { EditorServer } from "../editor-server.js";
import { engine, type PeaksResult, type PlayCommand } from "../engine.js";
import { pickAudioFile } from "../filepicker.js";
import { isGroupsEvent, normGroup, sendGroups } from "../groups.js";
import { mixer } from "../mixer.js";
import { outputItems, trackOutputs } from "../outputs.js";
import { playbacks, gainFor, inGroup, ctxOf, type Playback } from "../registry.js";
import { fmtTime, playKey, type PlayView } from "../render.js";
import { MAX_TRACKS, seconds, trackSettings, type PlaySettings } from "../settings.js";

/**
 * Path returned by the inspector's file picker: depending on the system it may be prefixed with
 * "C:\fakepath\", encoded, missing the leading "/" (macOS) or using "/" instead of "\" (Windows). We try the variants.
 */
function resolvePath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const stripped = p.replace(/^C:\\fakepath\\/i, "");
  let decoded = stripped;
  try { decoded = decodeURIComponent(stripped); } catch { /* not encoded */ }
  const candidates = new Set<string>([p, stripped, decoded]);
  for (const c of [...candidates]) {
    candidates.add("/" + c);
    if (process.platform === "win32") candidates.add(c.replace(/\//g, "\\"));
  }
  return [...candidates].find((c) => existsSync(c));
}

/** The tracks of a key have the id "<context>#<n>" on the engine side. */
const tracksOf = (ctx: string): Playback[] => [...playbacks.values()].filter((p) => ctxOf(p.id) === ctx);

/** The single running PlayAction, so other actions (Set Loop Point) can update a track's own settings. */
export let playAction: PlayAction | undefined;

@action({ UUID: "com.saap.audio.play" })
export class PlayAction extends SingletonAction<PlaySettings> {
  #keys = new Map<string, KeyAction<PlaySettings>>();
  #settings = new Map<string, PlaySettings>();
  #lastView = new Map<string, string>();

  /** The Play keys currently showing on a deck, in reading order: the editor's tabs. */
  #tabs(): object {
    const rows = [...this.#keys].map(([ctx, key]) => {
      const s = this.#settings.get(ctx) ?? {};
      const first = s.file as string | undefined;
      return {
        ctx, label: s.label || (first ? basename(first, extname(first)) : "Choose a file"), group: normGroup(s.group),
        device: key.device.id, row: key.coordinates?.row ?? 0, column: key.coordinates?.column ?? 0,
      };
    });
    rows.sort((a, b) => a.device.localeCompare(b.device) || a.row - b.row || a.column - b.column);
    return { event: "keys", items: rows.map(({ ctx, label, group }) => ({ ctx, label, group })) };
  }

  /** Large settings page opened in the browser (see EditorServer). */
  #editor = new EditorServer(
    {
      session: (ctx) => {
        const key = this.#keys.get(ctx);
        return key ? { action: "com.saap.audio.play", device: key.device.id, settings: this.#settings.get(ctx) ?? {}, coordinates: key.coordinates } : undefined;
      },
      setSettings: async (ctx, settings, origin) => {
        const key = this.#keys.get(ctx);
        if (!key) return;
        await this.#settingsChanged(ctx, key, settings as PlaySettings, origin);
        await key.setSettings(settings as PlaySettings);
      },
      message: (_ctx, payload, reply) => this.#handleMessage(payload, (p) => reply(p as object)),
    },
    fileURLToPath(new URL("../ui/", import.meta.url)),
  );

  constructor() {
    super();
    playAction = this;
    engine.on("started", (id, dur) => {
      const p = playbacks.get(id);
      if (p) { p.dur = dur; this.#render(ctxOf(id)); }
    });
    engine.on("state", (id, state, pos, dur, looping, exiting) => {
      const p = playbacks.get(id);
      if (!p) return;
      p.state = state; p.pos = pos; p.dur = dur; p.looping = looping; p.exiting = exiting;
      this.#render(ctxOf(id));
    });
    engine.on("ended", (id, reason, message) => {
      playbacks.delete(id);
      this.#render(ctxOf(id));
      if (reason === "error") {
        streamDeck.logger.error(`Playback ${id}: ${message}`);
        void this.#keys.get(ctxOf(id))?.showAlert();
      }
    });
    engine.on("reset", () => {
      const ctxs = new Set([...playbacks.keys()].map(ctxOf));
      playbacks.clear();
      ctxs.forEach((c) => this.#render(c));
    });
  }

  override onWillAppear(ev: WillAppearEvent<PlaySettings>): void {
    if (!ev.action.isKey()) return;
    this.#keys.set(ev.action.id, ev.action);
    this.#settings.set(ev.action.id, ev.payload.settings);
    mixer.addGroup(normGroup(ev.payload.settings.group));
    this.#lastView.delete(ev.action.id);
    this.#render(ev.action.id);
    this.#editor.broadcast(this.#tabs());
  }

  override onWillDisappear(ev: WillDisappearEvent<PlaySettings>): void {
    // playback continues if the user changes page: only the display is removed
    this.#keys.delete(ev.action.id);
    this.#editor.broadcast(this.#tabs());
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PlaySettings>): Promise<void> {
    await this.#settingsChanged(ev.action.id, ev.action, ev.payload.settings);
  }

  /** New settings for a key, from Stream Deck's own panel or from the large editor (`origin`, not echoed back to it). */
  async #settingsChanged(id: string, key: { setSettings(s: PlaySettings): Promise<void> }, settings: PlaySettings, origin?: WebSocket): Promise<void> {
    const newGroup = settings.newGroup?.trim();
    if (newGroup) {
      // name typed in "New group": it becomes the key's group and joins the menu
      mixer.addGroup(newGroup);
      const updated = { ...settings, group: newGroup, newGroup: "" };
      this.#settings.set(id, updated);
      await key.setSettings(updated);
      this.#editor.push(id, updated);
      this.#editor.broadcast(this.#tabs());
      await sendGroups("getGroupsPlay");
      return;
    }
    mixer.addGroup(normGroup(settings.group));
    // Stream Deck may echo back settings the editor itself just set: pushing those again would overwrite what
    // the user is typing there
    const known = JSON.stringify(this.#settings.get(id));
    this.#settings.set(id, settings);
    if (origin || JSON.stringify(settings) !== known) {
      this.#editor.push(id, settings, origin);
      this.#editor.broadcast(this.#tabs());
    }
    for (const p of tracksOf(id)) {
      // live volume: the inspector slider acts during playback
      const n = parseInt(p.id.split("#")[1], 10);
      p.settings = { ...p.settings, volume: trackSettings(settings, n).volume, group: normGroup(settings.group) };
      engine.volume(p.id, gainFor(p.settings));
    }
    this.#lastView.delete(id);
    this.#render(id);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, PlaySettings>): Promise<void> {
    const payload = ev.payload as { event?: string };
    if (payload.event === "openEditor") {
      await streamDeck.system.openUrl(await this.#editor.url(ev.action.id));
      return;
    }
    await this.#handleMessage(payload, (p) => streamDeck.ui.sendToPropertyInspector(p as JsonValue));
  }

  /** Messages from an inspector page (Stream Deck's panel or the large editor); `reply` answers that same page. */
  async #handleMessage(payload: object, reply: (p: object) => void | Promise<void>): Promise<void> {
    const event = (payload as { event?: string }).event;
    if (isGroupsEvent(event)) {
      await sendGroups(event, reply);
    } else if (event === "getPeaks") {
      const { file, track } = payload as { file?: string; track?: number };
      const path = resolvePath(file);
      const result = path ? await this.#peaks(path) : undefined;
      await reply({
        event: "peaks", track: track ?? 0, file: file ?? "",
        ...(result ? { duration: result.duration, peaks: result.peaks } : { error: path ? "Unreadable file" : "File not found" }),
      });
    } else if (event === "getOutputs") {
      await reply({ event, items: outputItems(await engine.devices()) });
    } else if (event === "getKeys") {
      await reply(this.#tabs());
    } else if (event === "pickFile") {
      const setting = (payload as { setting?: string }).setting;
      const path = await pickAudioFile();
      if (path && setting) await reply({ event: "pickedFile", setting, path });
    }
  }

  /**
   * Sets a track's loop-in or loop-out to a captured position (seconds), and turns Loop on for it — used
   * by the "Set Loop Point" action to mark a point live, during playback. Writes to the track's own
   * setting regardless of link state, same as typing into its field would (a linked track's own value
   * stays dormant until its link is unchecked).
   */
  async setLoopPoint(ctx: string, track: number, which: "in" | "out", positionSeconds: number): Promise<void> {
    const key = this.#keys.get(ctx);
    if (!key) return;
    const s = this.#settings.get(ctx) ?? {};
    const suffix = track === 1 ? "" : String(track);
    const updated: PlaySettings = { ...s, [`loop${which === "in" ? "In" : "Out"}${suffix}`]: positionSeconds.toFixed(2), [`loop${suffix}`]: true };
    this.#settings.set(ctx, updated);
    await key.setSettings(updated);
    this.#editor.push(ctx, updated);
    this.#lastView.delete(ctx);
    this.#render(ctx);
  }

  #peakCache = new Map<string, PeaksResult>();

  async #peaks(path: string): Promise<PeaksResult | undefined> {
    const key = `${path}:${statSync(path).mtimeMs}`;
    let r = this.#peakCache.get(key);
    if (!r) {
      r = await engine.peaks(path);
      if (r) this.#peakCache.set(key, r);
    }
    return r;
  }

  override onKeyDown(ev: KeyDownEvent<PlaySettings>): void {
    const id = ev.action.id;
    const s = ev.payload.settings;
    this.#settings.set(id, s);
    const current = tracksOf(id);

    if (current.length > 0 && s.mode !== "restart") {
      if (s.mode === "pause") {
        const ids = current.map((p) => p.id);
        current.some((p) => p.state === "playing") ? engine.pauseMany(ids) : engine.resumeMany(ids);
      } else {
        for (const p of current) engine.stopPlayback(p.id, seconds(p.settings.fadeOut));
      }
      return;
    }
    this.#start(id, s, ev.action);
  }

  #start(ctx: string, s: PlaySettings, key: { showAlert(): Promise<void> }): void {
    const tracks = Array.from({ length: MAX_TRACKS }, (_, i) => i + 1)
      .map((n) => ({ n, t: trackSettings(s, n) }))
      .map(({ n, t }) => ({ n, t, file: resolvePath(t.file as string | undefined) }))
      .filter(({ t }) => t.file);
    if (tracks.length === 0 || tracks.some((x) => !x.file)) {
      void key.showAlert();
      streamDeck.logger.warn(`File not found or no file chosen (key ${ctx})`);
      for (const { n, t, file } of tracks) {
        if (file) continue;
        const raw = String(t.file);
        // on Windows the picker may return only the file name, without its folder
        const hint = !/[\\/]/.test(raw.replace(/^C:\\fakepath\\/i, "")) ? " (name only, no folder: the picker did not provide the full path)" : "";
        streamDeck.logger.warn(`  track ${n}: received value ${JSON.stringify(raw)}${hint}`);
      }
      if (tracks.length === 0) return;
    }
    if (s.stopOthers) {
      for (const p of playbacks.values())
        if (ctxOf(p.id) !== ctx && inGroup(p, normGroup(s.group))) engine.stopPlayback(p.id, seconds(p.settings.fadeOut));
    }
    const commands: PlayCommand[] = [];
    for (const { n, t, file } of tracks) {
      if (!file) continue;
      // one playback per destination: the same track can go to several interfaces / channel pairs
      const outputs = trackOutputs(t);
      outputs.forEach((out, k) => {
        const id = k === 0 ? `${ctx}#${n}` : `${ctx}#${n}.${k}`;
        commands.push({
          id, file, device: out.device, channel: out.channel, mono: out.mono,
          volume: gainFor(t), loop: !!t.loop,
          fadeIn: seconds(t.fadeIn as number), fadeOut: seconds(t.fadeOut as number),
          trimIn: seconds(t.trimIn as string), trimOut: seconds(t.trimOut as string),
          loopIn: seconds(t.loopIn as string), loopOut: seconds(t.loopOut as string),
          loopFade: seconds(t.loopFade as string),
        });
        playbacks.set(id, { id, settings: t, state: "playing", pos: 0, dur: 0, looping: !!t.loop, exiting: false });
      });
    }
    streamDeck.logger.info(`Playback ${ctx}: ${tracks.length} track(s), ${commands.length} output(s)`);
    // all tracks start at the same exact instant (sync < 1 ms)
    engine.playBatch(commands);
    this.#render(ctx);
  }

  #render(id: string): void {
    const key = this.#keys.get(id);
    if (!key) return;
    const s = this.#settings.get(id) ?? {};
    const first = s.file as string | undefined;
    const label = s.label || (first ? basename(first, extname(first)) : "Choose a file");
    const active = tracksOf(id);
    const configured = Array.from({ length: MAX_TRACKS }, (_, i) => trackSettings(s, i + 1)).filter((t) => t.file).length;
    const remaining = s.countdown !== false;
    let view: PlayView;
    if (active.length === 0) {
      view = { label, group: normGroup(s.group), state: "idle", tracks: configured, loop: !!s.loop };
    } else {
      // the display follows the longest track (non-looping if possible)
      const measured = active.filter((p) => p.dur > 0);
      // once a track is exiting its loop, it behaves like a finite track again (an end is now in sight)
      const finite = measured.filter((p) => !p.settings.loop || p.exiting);
      const ref = (finite.length ? finite : measured).sort((a, b) => b.dur - b.pos - (a.dur - a.pos))[0];
      const looping = !!ref?.settings.loop && !ref?.exiting;
      const showRemaining = remaining && !looping;
      view = {
        label, group: normGroup(s.group), tracks: configured, loop: looping, exiting: !!ref?.exiting,
        state: active.every((p) => p.state === "paused") ? "paused" : "playing",
        time: ref ? (showRemaining ? "-" : "") + fmtTime(showRemaining ? ref.dur - ref.pos : ref.pos) : "…",
        progress: ref ? ref.pos / ref.dur : 0,
      };
    }
    // only resend the image when the display changed (time to the second, bar to the pixel)
    const sig = JSON.stringify({ ...view, progress: Math.round((view.progress ?? 0) * 60) });
    if (this.#lastView.get(id) === sig) return;
    this.#lastView.set(id, sig);
    void key.setImage(playKey(view));
  }
}
