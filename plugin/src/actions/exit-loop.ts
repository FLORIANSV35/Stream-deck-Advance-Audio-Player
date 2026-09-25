import {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { runExitLoop } from "../remote-actions.js";
import { isGroupsEvent, normGroup, sendGroups } from "../groups.js";
import { inGroup, playbacks } from "../registry.js";
import { exitLoopKey } from "../render.js";
import type { ExitLoopSettings } from "../settings.js";

/** Stops looping playbacks (all of them, or those of a group): each finishes its current iteration, then
 * plays through to its trim-out point instead of wrapping back to its loop-in point. No-op on tracks that
 * are not looping. */
@action({ UUID: "com.saap.audio.exitloop" })
export class ExitLoopAction extends SingletonAction<ExitLoopSettings> {
  #image(s: ExitLoopSettings): string {
    return exitLoopKey({ label: s.label?.trim() || "Exit loop", group: normGroup(s.group) });
  }

  override onWillAppear(ev: WillAppearEvent<ExitLoopSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(this.#image(ev.payload.settings));
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ExitLoopSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(this.#image(ev.payload.settings));
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, ExitLoopSettings>): Promise<void> {
    const event = (ev.payload as { event?: string }).event;
    if (isGroupsEvent(event)) await sendGroups(event);
  }

  override onKeyDown(ev: KeyDownEvent<ExitLoopSettings>): void {
    runExitLoop(ev.payload.settings);
  }
}
