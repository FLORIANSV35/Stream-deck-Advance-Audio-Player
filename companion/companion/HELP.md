# SAAP Audio

Plays several synchronized audio tracks at once, straight from a Companion button — the same native audio engine
(and the same trim/loop/fade/routing/group model) as the [SAAP Audio Stream Deck plugin](https://github.com/FLORIANSV35/Stream-deck-Advance-Audio-Player),
now running directly inside Companion. No Stream Deck required.

## Getting started

1. Add this connection, then add the **Open Sound Editor** action to any button and press it — it opens the
   editor in your default browser. (Its URL is also shown in this connection's status, like
   `Editor: http://127.0.0.1:PORT/TOKEN/`, if you'd rather open it by hand.)
2. On that page, click **+ New sound**, give it an id (e.g. `applause`), and set up its file, output, volume,
   fades, trim and loop points there — the waveform, drag-and-drop, and the **Browse…** button all work exactly
   like the Stream Deck plugin's own editor.
3. On a button, add the **Play Sound** action and type that same id into its **Sound** field. Press the button.
   (Or drag in the **Play Sound** preset from this connection's Presets tab — same dark/green/amber look as the
   Stream Deck plugin's own key, already wired with the is-playing/is-paused feedbacks, just fill in the Sound id.)
4. Adding another Sound-id action or feedback to that same button (Stop, a feedback, …)? Click its **Learn**
   button instead of retyping the id — it copies whatever Sound id is already set on that button.

## Presets

Every action below has a matching preset (Presets tab, under this connection) styled like the plugin's own keys:
dark idle background, green while a sound plays, amber while paused, blue for loop/skip controls, coral for
Stop All. Drag one onto a button and fill in its Sound/Group id.

## Why a separate web page?

Companion's own action editor only offers plain fields (text, number, checkbox, dropdown) — there is no way to
draw a waveform or open a native file dialog from inside it. So the rich part of the setup (the same experience
as the Stream Deck plugin's "large editor") lives on this one web page instead, and a button only needs to know
which sound (by id) to play, stop, pause, etc. One upside: several buttons can share the same sound id.

## Actions

- **Open Sound Editor** — opens the web editor in the default browser. Put this on a button for one-click access
  instead of copying the URL from the connection's status.
- **Play Sound** — starts every track of a sound that has a file, all in sync. If it's already playing, its
  "On press while playing" setting (in the web editor) decides what a second press does: restart, stop, or
  pause/resume.
- **Stop** — targets one sound by id, or every sound when left blank (same fade for either).
- **Pause / Resume** — targets one sound by id.
- **Stop All**, **Skip forward / back**, **Exit Loop** — target a group (set per-sound in the web editor), or
  every sound when left blank.
- **Set Loop Point** — while a sound is playing, captures its current position as that sound's loop-in or
  loop-out point (same as the Stream Deck plugin's own "Set Loop Point" key).
- **Set Volume (master / group)** — set, nudge, or mute the master level or a named group's level.

## Feedbacks

- **Sound Title + Time** — the button's name (that sound's "Label" in the web editor, or its id) plus a live
  elapsed/remaining countdown and a PAUSE/LOOP indicator while it's active, updated about 10×/s — closest match
  to the Stream Deck plugin's own key. Already on the **Play Sound** preset.
- **Sound Title** — just the name, no countdown, for a plainer button.
- **Sound is playing** / **Sound is paused** — both take a Sound id, for coloring a button by that sound's state.

## Update checks

The web editor shows a banner when a newer release of this module is available on GitHub (one anonymous check a
day). Unlike the Stream Deck plugin, there's no self-install — the banner just links to the release page, since
Companion has no way to update a manually-installed module for you; download and re-import it yourself. Turn it
off with the banner's own "Don't check for updates" button.

## Known limitations vs. the Stream Deck plugin

- File paths are typed/pasted, or chosen via the native **Browse…** dialog / drag-and-drop on the web editor —
  Companion's own action fields cannot open a file picker.
- Requires macOS or Windows (same native engine as the plugin; no Linux build).
- The web editor only works from the same machine Companion runs on (it opens a native OS file dialog, and is
  bound to 127.0.0.1 for security).
