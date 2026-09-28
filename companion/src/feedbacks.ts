import { combineRgb, type CompanionFeedbackDefinitions } from "@companion-module/base";
import type { Player } from "./player.js";
import type { Store } from "./store.js";

const soundIdField = { id: "soundId", type: "textinput" as const, label: "Sound", default: "" };

export function getFeedbackDefinitions(player: Player, store: Store): CompanionFeedbackDefinitions {
  return {
    "sound-title": {
      type: "advanced",
      name: "Sound Title (shows the sound's label on the button)",
      options: [soundIdField],
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
      callback: (feedback) => player.isActuallyPlaying(String(feedback.options.soundId ?? "").trim()),
    },
    "is-paused": {
      type: "boolean",
      name: "Sound is paused",
      defaultStyle: { bgcolor: combineRgb(245, 158, 11), color: combineRgb(46, 30, 5) },
      options: [soundIdField],
      callback: (feedback) => {
        const id = String(feedback.options.soundId ?? "").trim();
        return player.isPlaying(id) && !player.isActuallyPlaying(id);
      },
    },
  };
}
