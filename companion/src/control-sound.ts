/** Remembers the last Sound id an action on a given button (controlId) was configured with, so a feedback or
 * another action on that same button can "Learn" it instead of the user retyping it into every field. Companion
 * gives actions/feedbacks no direct way to read each other's options, so this is the module's own bookkeeping,
 * updated from every soundId-taking action's `subscribe` hook (called whenever Companion (re)reports that
 * action's existence, e.g. on load or after an edit) and read from their `learn` hooks. */
const lastSoundIdByControl = new Map<string, string>();

export function rememberSoundId(controlId: string, soundId: string): void {
  if (soundId) lastSoundIdByControl.set(controlId, soundId);
}

export function lastSoundIdFor(controlId: string): string | undefined {
  return lastSoundIdByControl.get(controlId);
}
