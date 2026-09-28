import { combineRgb, type CompanionFeedbackDefinitions, type CompanionFeedbackInfo } from "@companion-module/base";
import { lastSoundIdFor } from "./control-sound.js";
import type { Player } from "./player.js";
import type { Store } from "./store.js";

const soundIdField = {
  id: "soundId",
  type: "textinput" as const,
  label: "Sound",
  default: "",
  tooltip: "Click \"Learn\" to copy the Sound id from a Play Sound/Stop/Pause action already on this button.",
};

/** Shared by every feedback that takes a Sound id: "Learn" copies whatever a soundId-taking action on the same
 * button was last configured with (see control-sound.ts). */
const soundIdLearn = (feedback: CompanionFeedbackInfo) => {
  const soundId = lastSoundIdFor(feedback.controlId);
  return soundId ? { ...feedback.options, soundId } : undefined;
};

/** m:ss, rounded up — same format as the Stream Deck plugin's own key (plugin/src/render.ts's fmtTime). */
const fmtTime = (sec: number): string => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function getFeedbackDefinitions(player: Player, store: Store): CompanionFeedbackDefinitions {
  return {
    "sound-time": {
      type: "advanced",
      name: "Sound Title + Time (name, live countdown, PAUSE/LOOP)",
      options: [
        soundIdField,
        {
          id: "mode", type: "dropdown", label: "Show", default: "elapsed",
          choices: [{ id: "elapsed", label: "Elapsed" }, { id: "remaining", label: "Remaining" }],
        },
      ],
      learn: soundIdLearn,
      callback: (feedback) => {
        const id = String(feedback.options.soundId ?? "").trim();
        if (!id) return {};
        const label = store.sound(id).label || id;
        const info = player.timeInfo(id);
        if (!info) return { text: label };
        const t = feedback.options.mode === "remaining" ? Math.max(0, info.dur - info.pos) : info.pos;
        const state = info.paused ? "PAUSE" : info.looping ? "LOOP" : "";
        return { text: state ? `${label}\n${fmtTime(t)}\n${state}` : `${label}\n${fmtTime(t)}` };
      },
    },
    "sound-title": {
      type: "advanced",
      name: "Sound Title (shows the sound's label on the button)",
      options: [soundIdField],
      learn: soundIdLearn,
      callback: (feedback) => {
        const id = String(feedback.options.soundId ?? "").trim();
        if (!id) return {};
        return { text: store.sound(id).label || id };
      },
    },
    "is-playing": {
      type: "boolean",
      name: "Sound is playing",
      defaultStyle: { bgcolor: combineRgb(34, 197, 94), color: combineRgb(5, 46, 29) },
      options: [soundIdField],
      learn: soundIdLearn,
      callback: (feedback) => player.isActuallyPlaying(String(feedback.options.soundId ?? "").trim()),
    },
    "is-paused": {
      type: "boolean",
      name: "Sound is paused",
      defaultStyle: { bgcolor: combineRgb(245, 158, 11), color: combineRgb(46, 30, 5) },
      options: [soundIdField],
      learn: soundIdLearn,
      callback: (feedback) => {
        const id = String(feedback.options.soundId ?? "").trim();
        return player.isPlaying(id) && !player.isActuallyPlaying(id);
      },
    },
  };
}
