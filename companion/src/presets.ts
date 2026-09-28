import {
  combineRgb,
  type CompanionButtonPresetDefinition,
  type CompanionOptionValues,
  type CompanionPresetDefinitions,
} from "@companion-module/base";

// Same palette as the Stream Deck plugin's own keys and web UI (see plugin's .github/readme/keys-overview.png
// and plugin/com.saap.audio.sdPlugin/ui/saap.css): dark idle background, green while playing, amber while
// paused, blue for loop/skip controls, coral for "Stop all".
const IDLE_BG = combineRgb(20, 22, 26); // #14161a
const IDLE_TEXT = combineRgb(232, 234, 239); // #e8eaef
const GREEN = combineRgb(34, 197, 94); // #22c55e
const GREEN_TEXT = combineRgb(5, 46, 29); // #052e1d
const AMBER = combineRgb(245, 158, 11); // #f59e0b
const AMBER_TEXT = combineRgb(46, 30, 5);
const BLUE = combineRgb(59, 130, 246); // #3b82f6
const CORAL = combineRgb(248, 113, 113); // #f87171
const CORAL_TEXT = combineRgb(46, 10, 10);

function button(
  category: string,
  name: string,
  text: string,
  actionId: string,
  options: CompanionOptionValues,
  bgcolor = IDLE_BG,
  color = IDLE_TEXT,
): CompanionButtonPresetDefinition {
  return {
    type: "button",
    category,
    name,
    style: { text, size: "14", color, bgcolor },
    feedbacks: [],
    steps: [{ down: [{ actionId, options }], up: [] }],
  };
}

/**
 * Ready-made buttons matching the Stream Deck plugin's own keys, in look (same dark/green/amber/blue/coral
 * palette) and in behavior: "Play Sound" is the one interactive key that does double duty exactly like the
 * plugin's — press to start, press again to restart/stop/pause per that sound's own "On press while playing"
 * setting (set in the web editor) — everything else here is a plain one-shot control, same as the plugin's
 * Volume/Skip/Exit Loop/Stop all/Set Loop Point keys. A person drags one onto their grid and fills in a Sound id
 * (or a Group, for the group-scoped controls).
 */
export function getPresetDefinitions(): CompanionPresetDefinitions {
  return {
    "open-editor": button("General", "Open Sound Editor", "Open\nSound\nEditor", "open-editor", {}, IDLE_BG, BLUE),
    "play-sound": {
      type: "button",
      category: "Playback",
      name: "Play Sound",
      style: { text: "Play\nSound", size: "14", color: IDLE_TEXT, bgcolor: IDLE_BG },
      feedbacks: [
        { feedbackId: "is-playing", options: { soundId: "" }, style: { bgcolor: GREEN, color: GREEN_TEXT } },
        { feedbackId: "is-paused", options: { soundId: "" }, style: { bgcolor: AMBER, color: AMBER_TEXT } },
      ],
      steps: [{ down: [{ actionId: "play-sound", options: { soundId: "" } }], up: [] }],
    },
    stop: button("Playback", "Stop", "Stop", "stop", { soundId: "", fade: 0 }),
    "pause-resume": button("Playback", "Pause / Resume", "Pause /\nResume", "pause-resume", { soundId: "" }),
    "stop-all": button("Playback", "Stop All", "Stop\nall", "stop-all", { group: "", mode: "fade", fade: 1 }, CORAL, CORAL_TEXT),
    "skip-forward": button("Playback", "Skip forward 10s", "+10s", "skip", { group: "", direction: "forward", seconds: 10 }, IDLE_BG, BLUE),
    "skip-back": button("Playback", "Skip back 10s", "-10s", "skip", { group: "", direction: "back", seconds: 10 }, IDLE_BG, BLUE),
    "exit-loop": button("Playback", "Exit Loop", "Exit\nLoop", "exit-loop", { group: "" }, IDLE_BG, BLUE),
    "set-loop-in": button("Playback", "Set Loop In", "Loop\nin", "set-loop-point", { soundId: "", which: "in" }, IDLE_BG, BLUE),
    "set-loop-out": button("Playback", "Set Loop Out", "Loop\nout", "set-loop-point", { soundId: "", which: "out" }, IDLE_BG, BLUE),
    "mute-master": button("Mixer", "Mute Master", "Mute", "set-volume", { target: "*", mode: "mute" }, IDLE_BG, GREEN),
    "volume-up": button("Mixer", "Master Volume +10%", "Vol\n+10%", "set-volume", { target: "*", mode: "up", step: 10 }, IDLE_BG, GREEN),
    "volume-down": button("Mixer", "Master Volume -10%", "Vol\n-10%", "set-volume", { target: "*", mode: "down", step: 10 }, IDLE_BG, GREEN),
  };
}
