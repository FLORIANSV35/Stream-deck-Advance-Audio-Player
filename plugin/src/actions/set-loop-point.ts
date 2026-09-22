import {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { isGroupsEvent, normGroup, sendGroups } from "../groups.js";
import { ctxOf, inGroup, playbacks, trackOf } from "../registry.js";
import { loopPointKey } from "../render.js";
import type { SetLoopPointSettings } from "../settings.js";
import { playAction } from "./play.js";

/** Marks a loop-in or loop-out point live, at the current playback position, for every running track
 * matching a group (all sounds, or one group) — one write per distinct track, even if it plays on several
 * outputs. Also turns Loop on for each track it touches. No effect if nothing matching is playing. */
@action({ UUID: "com.saap.audio.looppoint" })
export class SetLoopPointAction extends SingletonAction<SetLoopPointSettings> {
  #image(s: SetLoopPointSettings): string {
    const which = s.which === "out" ? "out" : "in";
    return loopPointKey({ label: s.label?.trim() || `Loop ${which}`, group: normGroup(s.group), which });
  }

  override onWillAppear(ev: WillAppearEvent<SetLoopPointSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(this.#image(ev.payload.settings));
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SetLoopPointSettings>): void {
    if (ev.action.isKey()) void ev.action.setImage(this.#image(ev.payload.settings));
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SetLoopPointSettings>): Promise<void> {
    const event = (ev.payload as { event?: string }).event;
    if (isGroupsEvent(event)) await sendGroups(event);
  }

  override async onKeyDown(ev: KeyDownEvent<SetLoopPointSettings>): Promise<void> {
    const s = ev.payload.settings;
    const which = s.which === "out" ? "out" : "in";
    const group = normGroup(s.group);
    // one write per distinct track: a track with several outputs has several playback entries for it
    const seen = new Set<string>();
    let matched = false;
    for (const p of playbacks.values()) {
      if (!inGroup(p, group)) continue;
      const ctx = ctxOf(p.id), track = trackOf(p.id);
      const key = `${ctx}#${track}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched = true;
      await playAction?.setLoopPoint(ctx, track, which, p.pos);
    }
    if (matched) void ev.action.showOk();
    else void ev.action.showAlert();
  }
}
