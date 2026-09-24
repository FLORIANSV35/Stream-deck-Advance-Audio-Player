import {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { runStopAll } from "../remote-actions.js";
import { isGroupsEvent, normGroup, sendGroups } from "../groups.js";
import { inGroup, playbacks } from "../registry.js";
import { stopKey } from "../render.js";
import type { StopAllSettings } from "../settings.js";

@action({ UUID: "com.saap.audio.stopall" })
export class StopAllAction extends SingletonAction<StopAllSettings> {
  #image(s: StopAllSettings): string {
    const mode = s.mode === "cut" ? "cut" : "fade";
    return stopKey({ label: s.label?.trim() || "Stop all", group: normGroup(s.group), mode, fade: s.fade ?? 1.5 });
  }

  override onWillAppear(ev: WillAppearEvent<StopAllSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(this.#image(ev.payload.settings));
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<StopAllSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(this.#image(ev.payload.settings));
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, StopAllSettings>): Promise<void> {
    const event = (ev.payload as { event?: string }).event;
    if (isGroupsEvent(event)) await sendGroups(event);
  }

  override onKeyDown(ev: KeyDownEvent<StopAllSettings>): void {
    runStopAll(ev.payload.settings);
  }
}
