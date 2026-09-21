import {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { engine } from "../engine.js";
import { isGroupsEvent, normGroup, sendGroups } from "../groups.js";
import { inGroup, playbacks } from "../registry.js";
import { stopKey } from "../render.js";
import type { StopAllSettings } from "../settings.js";

@action({ UUID: "com.saap.audio.stopall" })
export class StopAllAction extends SingletonAction<StopAllSettings> {
  override onWillAppear(ev: WillAppearEvent<StopAllSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(stopKey(normGroup(ev.payload.settings.group) || "Tout arrêter"));
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<StopAllSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(stopKey(normGroup(ev.payload.settings.group) || "Tout arrêter"));
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, StopAllSettings>): Promise<void> {
    const event = (ev.payload as { event?: string }).event;
    if (isGroupsEvent(event)) await sendGroups(event);
  }

  override onKeyDown(ev: KeyDownEvent<StopAllSettings>): void {
    const s = ev.payload.settings;
    for (const p of playbacks.values()) {
      if (!inGroup(p, normGroup(s.group))) continue;
      if (s.mode === "cut") engine.cut(p.id);
      else engine.stopPlayback(p.id, s.fade ?? 1.5);
    }
  }
}
