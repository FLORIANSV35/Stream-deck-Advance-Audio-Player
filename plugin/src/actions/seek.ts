import {
  action,
  SingletonAction,
  type DialAction,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { engine } from "../engine.js";
import { runSkip } from "../remote-actions.js";
import { isGroupsEvent, normGroup, sendGroups } from "../groups.js";
import { inGroup, playbacks, type Playback } from "../registry.js";
import { fmtTime, seekKey } from "../render.js";
import type { SeekSettings } from "../settings.js";

type Surface = KeyAction<SeekSettings> | DialAction<SeekSettings>;

const targets = (s: SeekSettings): Playback[] =>
  [...playbacks.values()].filter((p) => p.dur > 0 && inGroup(p, normGroup(s.group)));

/** Skips forward / back in running playbacks (all of them, or those of a group). */
@action({ UUID: "com.saap.audio.seek" })
export class SeekAction extends SingletonAction<SeekSettings> {
  #surfaces = new Map<string, Surface>();
  #settings = new Map<string, SeekSettings>();
  #lastView = new Map<string, string>();

  constructor() {
    super();
    const refresh = () => this.#surfaces.forEach((_, id) => this.#render(id));
    engine.on("state", refresh);
    engine.on("ended", refresh);
  }

  override onWillAppear(ev: WillAppearEvent<SeekSettings>): void {
    this.#surfaces.set(ev.action.id, ev.action as Surface);
    this.#settings.set(ev.action.id, ev.payload.settings);
    this.#lastView.delete(ev.action.id);
    this.#render(ev.action.id);
  }

  override onWillDisappear(ev: WillDisappearEvent<SeekSettings>): void {
    this.#surfaces.delete(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SeekSettings>): void {
    this.#settings.set(ev.action.id, ev.payload.settings);
    this.#lastView.delete(ev.action.id);
    this.#render(ev.action.id);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SeekSettings>): Promise<void> {
    const event = (ev.payload as { event?: string }).event;
    if (isGroupsEvent(event)) await sendGroups(event);
  }

  override onKeyDown(ev: KeyDownEvent<SeekSettings>): void {
    runSkip(ev.payload.settings);
  }

  override onDialRotate(ev: DialRotateEvent<SeekSettings>): void {
    // a single command for all playbacks: they skip together and stay in sync
    const ids = targets(ev.payload.settings).map((p) => p.id);
    if (ids.length > 0) engine.seekMany(ids, ev.payload.ticks * (ev.payload.settings.dialStep ?? 2));
  }

  override onDialDown(ev: DialDownEvent<SeekSettings>): void {
    this.#togglePause(ev.payload.settings);
  }

  override onTouchTap(ev: TouchTapEvent<SeekSettings>): void {
    this.#togglePause(ev.payload.settings);
  }

  #togglePause(s: SeekSettings): void {
    const list = [...playbacks.values()].filter((p) => inGroup(p, normGroup(s.group)));
    const ids = list.map((p) => p.id);
    if (ids.length === 0) return;
    list.some((p) => p.state === "playing") ? engine.pauseMany(ids) : engine.resumeMany(ids);
  }

  #render(id: string): void {
    const surface = this.#surfaces.get(id);
    if (!surface) return;
    const s = this.#settings.get(id) ?? {};
    const group = normGroup(s.group);
    let view: object;
    if (surface.isDial()) {
      // shows the position of the longest playback
      const ref = targets(s).sort((a, b) => b.dur - a.dur)[0];
      view = {
        title: group || "Position",
        value: ref ? `${fmtTime(ref.pos)} / ${fmtTime(ref.dur)}` : "—",
        indicator: { value: ref ? Math.round((ref.pos / ref.dur) * 100) : 0 },
      };
    } else {
      view = { dir: s.direction === "back" ? -1 : 1, seconds: s.seconds ?? 10, group };
    }
    const sig = JSON.stringify(view);
    if (this.#lastView.get(id) === sig) return;
    this.#lastView.set(id, sig);
    if (surface.isDial()) void surface.setFeedback(view as never);
    else void surface.setImage(seekKey(view as never));
  }
}
