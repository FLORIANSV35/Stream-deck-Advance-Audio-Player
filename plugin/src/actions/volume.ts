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
import { isGroupsEvent, sendGroups } from "../groups.js";
import { mixer } from "../mixer.js";
import { runVolume } from "../remote-actions.js";
import { volumeKey } from "../render.js";
import type { VolumeSettings } from "../settings.js";

type Surface = KeyAction<VolumeSettings> | DialAction<VolumeSettings>;

@action({ UUID: "com.saap.audio.volume" })
export class VolumeAction extends SingletonAction<VolumeSettings> {
  #surfaces = new Map<string, Surface>();
  #settings = new Map<string, VolumeSettings>();

  constructor() {
    super();
    mixer.on("change", () => this.#surfaces.forEach((_, id) => this.#render(id)));
  }

  override onWillAppear(ev: WillAppearEvent<VolumeSettings>): void {
    this.#surfaces.set(ev.action.id, ev.action as Surface);
    this.#settings.set(ev.action.id, ev.payload.settings);
    this.#render(ev.action.id);
  }

  override onWillDisappear(ev: WillDisappearEvent<VolumeSettings>): void {
    this.#surfaces.delete(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<VolumeSettings>): void {
    this.#settings.set(ev.action.id, ev.payload.settings);
    this.#render(ev.action.id);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, VolumeSettings>): Promise<void> {
    const event = (ev.payload as { event?: string }).event;
    if (isGroupsEvent(event)) await sendGroups(event);
  }

  override onKeyDown(ev: KeyDownEvent<VolumeSettings>): void {
    runVolume(ev.payload.settings);
  }

  override onDialRotate(ev: DialRotateEvent<VolumeSettings>): void {
    const target = ev.payload.settings.target || "*";
    const step = ev.payload.settings.step ?? 2;
    mixer.set(target, { pct: mixer.level(target).pct + ev.payload.ticks * step, muted: false });
  }

  override onDialDown(ev: DialDownEvent<VolumeSettings>): void {
    this.#toggleMute(ev.payload.settings);
  }

  override onTouchTap(ev: TouchTapEvent<VolumeSettings>): void {
    this.#toggleMute(ev.payload.settings);
  }

  #toggleMute(s: VolumeSettings): void {
    const target = s.target || "*";
    mixer.set(target, { muted: !mixer.level(target).muted });
  }

  #render(id: string): void {
    const surface = this.#surfaces.get(id);
    if (!surface) return;
    const s = this.#settings.get(id) ?? {};
    const target = s.target || "*";
    const lvl = mixer.level(target);
    if (surface.isDial()) {
      void surface.setFeedback({
        title: target === "*" ? "Master" : target,
        value: lvl.muted ? "MUTE" : `${lvl.pct}%`,
        // the ring only takes 0-100; a boost above unity just shows as full, the number alongside still reads the real value
        indicator: { value: lvl.muted ? 0 : Math.min(100, lvl.pct) },
      });
    } else {
      void surface.setImage(volumeKey({ target, icon: s.mode ?? "up", pct: lvl.pct, muted: lvl.muted }));
    }
  }
}
