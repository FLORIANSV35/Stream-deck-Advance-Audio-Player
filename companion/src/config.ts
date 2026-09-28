import type { SomeCompanionConfigField } from "@companion-module/base";

export interface SaapConfig {
  /** Where sound settings and dropped-file uploads are stored. Empty = a default folder under the user's home
   * directory, namespaced by this connection's id so several SAAP Audio connections don't collide. */
  dataDir?: string;
}

export function getConfigFields(): SomeCompanionConfigField[] {
  return [
    {
      id: "info",
      type: "static-text",
      label: "About",
      width: 12,
      value:
        "Plays multi-track synchronized sounds directly from Companion, using the same native audio engine as " +
        "the SAAP Audio Stream Deck plugin. Files, tracks, trim/loop points, routing, and groups are all set on " +
        "a web page this connection serves — its address is shown as this connection's status once it starts.",
    },
    {
      id: "dataDir",
      type: "textinput",
      label: "Data folder (optional)",
      tooltip: "Leave blank to use the default location under your home folder.",
      default: "",
      width: 12,
    },
  ];
}
