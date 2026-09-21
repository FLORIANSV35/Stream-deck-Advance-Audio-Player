import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
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
import { engine, type PeaksResult, type PlayCommand } from "../engine.js";
import { isGroupsEvent, normGroup, sendGroups } from "../groups.js";
import { mixer } from "../mixer.js";
import { outputItems, trackOutputs } from "../outputs.js";
import { playbacks, gainFor, inGroup, type Playback } from "../registry.js";
import { fmtTime, playKey, type PlayView } from "../render.js";
import { MAX_TRACKS, seconds, trackSettings, type PlaySettings } from "../settings.js";

/**
 * Chemin renvoyé par le sélecteur de fichier de l'inspecteur : selon le système, il peut être préfixé par
 * "C:\fakepath\", encodé, sans "/" initial (macOS) ou avec des "/" au lieu de "\" (Windows). On essaie les variantes.
 */
function resolvePath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const stripped = p.replace(/^C:\\fakepath\\/i, "");
  let decoded = stripped;
  try { decoded = decodeURIComponent(stripped); } catch { /* pas encodé */ }
  const candidates = new Set<string>([p, stripped, decoded]);
  for (const c of [...candidates]) {
    candidates.add("/" + c);
    if (process.platform === "win32") candidates.add(c.replace(/\//g, "\\"));
  }
  return [...candidates].find((c) => existsSync(c));
}

/** Les pistes d'une touche ont l'identifiant "<contexte>#<n>" côté moteur. */
const ctxOf = (id: string) => id.split("#")[0];
const tracksOf = (ctx: string): Playback[] => [...playbacks.values()].filter((p) => ctxOf(p.id) === ctx);

@action({ UUID: "com.saap.audio.play" })
export class PlayAction extends SingletonAction<PlaySettings> {
  #keys = new Map<string, KeyAction<PlaySettings>>();
  #settings = new Map<string, PlaySettings>();
  #lastView = new Map<string, string>();

  constructor() {
    super();
    engine.on("started", (id, dur) => {
      const p = playbacks.get(id);
      if (p) { p.dur = dur; this.#render(ctxOf(id)); }
    });
    engine.on("state", (id, state, pos, dur) => {
      const p = playbacks.get(id);
      if (!p) return;
      p.state = state; p.pos = pos; p.dur = dur;
      this.#render(ctxOf(id));
    });
    engine.on("ended", (id, reason, message) => {
      playbacks.delete(id);
      this.#render(ctxOf(id));
      if (reason === "error") {
        streamDeck.logger.error(`Lecture ${id} : ${message}`);
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
  }

  override onWillDisappear(ev: WillDisappearEvent<PlaySettings>): void {
    // la lecture continue si l'utilisateur change de page : on ne retire que l'affichage
    this.#keys.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PlaySettings>): Promise<void> {
    const id = ev.action.id;
    const newGroup = ev.payload.settings.newGroup?.trim();
    if (newGroup) {
      // nom saisi dans « Nouveau groupe » : il devient le groupe de la touche et rejoint le menu
      mixer.addGroup(newGroup);
      await ev.action.setSettings({ ...ev.payload.settings, group: newGroup, newGroup: "" });
      await sendGroups("getGroupsPlay");
      return;
    }
    mixer.addGroup(normGroup(ev.payload.settings.group));
    this.#settings.set(id, ev.payload.settings);
    for (const p of tracksOf(id)) {
      // volume live : le curseur de l'inspecteur agit pendant la lecture
      const n = parseInt(p.id.split("#")[1], 10);
      p.settings = { ...p.settings, volume: trackSettings(ev.payload.settings, n).volume, group: normGroup(ev.payload.settings.group) };
      engine.volume(p.id, gainFor(p.settings));
    }
    this.#lastView.delete(id);
    this.#render(id);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, PlaySettings>): Promise<void> {
    const event = (ev.payload as { event?: string }).event;
    if (isGroupsEvent(event)) {
      await sendGroups(event);
    } else if (event === "getPeaks") {
      const { file, track } = ev.payload as { file?: string; track?: number };
      const path = resolvePath(file);
      const result = path ? await this.#peaks(path) : undefined;
      await streamDeck.ui.sendToPropertyInspector({
        event: "peaks", track: track ?? 0, file: file ?? "",
        ...(result ? { duration: result.duration, peaks: result.peaks } : { error: path ? "Fichier illisible" : "Fichier introuvable" }),
      } as JsonValue);
    } else if (event === "getOutputs") {
      await streamDeck.ui.sendToPropertyInspector({ event, items: outputItems(await engine.devices()) } as JsonValue);
    }
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
      streamDeck.logger.warn(`Fichier introuvable ou aucun fichier choisi (touche ${ctx})`);
      for (const { n, t, file } of tracks) {
        if (file) continue;
        const raw = String(t.file);
        // sur Windows, le sélecteur peut ne renvoyer que le nom du fichier, sans son dossier
        const hint = !/[\\/]/.test(raw.replace(/^C:\\fakepath\\/i, "")) ? " (nom seul, sans dossier : chemin complet non fourni par le sélecteur)" : "";
        streamDeck.logger.warn(`  piste ${n} : valeur reçue ${JSON.stringify(raw)}${hint}`);
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
      // une lecture par destination : la même piste peut sortir sur plusieurs interfaces / paires de canaux
      const outputs = trackOutputs(t);
      outputs.forEach((out, k) => {
        const id = k === 0 ? `${ctx}#${n}` : `${ctx}#${n}.${k}`;
        commands.push({
          id, file, device: out.device, channel: out.channel, mono: out.mono,
          volume: gainFor(t), loop: !!t.loop,
          fadeIn: seconds(t.fadeIn as number), fadeOut: seconds(t.fadeOut as number),
          trimIn: seconds(t.trimIn as string), trimOut: seconds(t.trimOut as string),
        });
        playbacks.set(id, { id, settings: t, state: "playing", pos: 0, dur: 0 });
      });
    }
    streamDeck.logger.info(`Lecture ${ctx} : ${tracks.length} piste(s), ${commands.length} sortie(s)`);
    // toutes les pistes partent sur le même instant précis (synchro < 1 ms)
    engine.playBatch(commands);
    this.#render(ctx);
  }

  #render(id: string): void {
    const key = this.#keys.get(id);
    if (!key) return;
    const s = this.#settings.get(id) ?? {};
    const first = s.file as string | undefined;
    const label = s.label || (first ? basename(first, extname(first)) : "Choisir un fichier");
    const active = tracksOf(id);
    const configured = Array.from({ length: MAX_TRACKS }, (_, i) => trackSettings(s, i + 1)).filter((t) => t.file).length;
    const remaining = s.countdown !== false;
    let view: PlayView;
    if (active.length === 0) {
      view = { label, group: normGroup(s.group), state: "idle", tracks: configured, loop: !!s.loop };
    } else {
      // l'affichage suit la piste qui dure le plus longtemps (hors boucle si possible)
      const measured = active.filter((p) => p.dur > 0);
      const finite = measured.filter((p) => !p.settings.loop);
      const ref = (finite.length ? finite : measured).sort((a, b) => b.dur - b.pos - (a.dur - a.pos))[0];
      const looping = !!ref?.settings.loop;
      const showRemaining = remaining && !looping;
      view = {
        label, group: normGroup(s.group), tracks: configured, loop: looping,
        state: active.every((p) => p.state === "paused") ? "paused" : "playing",
        time: ref ? (showRemaining ? "-" : "") + fmtTime(showRemaining ? ref.dur - ref.pos : ref.pos) : "…",
        progress: ref ? ref.pos / ref.dur : 0,
      };
    }
    // ne renvoie l'image que si l'affichage a changé (temps à la seconde, barre au pixel)
    const sig = JSON.stringify({ ...view, progress: Math.round((view.progress ?? 0) * 60) });
    if (this.#lastView.get(id) === sig) return;
    this.#lastView.set(id, sig);
    void key.setImage(playKey(view));
  }
}
