import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { mixer } from "./mixer.js";

/** Valeurs spéciales des menus : "none" (aucun groupe) et "*" (tous / général) valent « pas de groupe ». */
export const normGroup = (g: unknown): string => (typeof g !== "string" || g === "none" || g === "*" ? "" : g);

/** Menus déroulants de groupes de l'inspecteur : chaque action a sa première entrée. */
const FIRST_ENTRY: Record<string, { label: string; value: string }> = {
  getGroupsPlay: { label: "— Aucun groupe —", value: "none" },
  getGroupsVolume: { label: "Général (tous les sons)", value: "*" },
  getGroupsStop: { label: "Tous les sons", value: "*" },
};

export const isGroupsEvent = (event: unknown): event is string => typeof event === "string" && event in FIRST_ENTRY;

export async function sendGroups(event: string): Promise<void> {
  const items = [FIRST_ENTRY[event], ...mixer.groups().map((g) => ({ label: g, value: g }))];
  await streamDeck.ui.sendToPropertyInspector({ event, items } as JsonValue);
}
