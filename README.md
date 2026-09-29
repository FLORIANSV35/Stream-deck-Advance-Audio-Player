# SAAP — advanced audio player for Stream Deck and Bitfocus Companion

Play several audio files at once from a single key, send each one to the audio interface and outputs you choose,
and control it live. Works on **macOS** and **Windows**, either as a **Stream Deck plugin** or, with no Stream
Deck at all, as a **Bitfocus Companion module** ([`companion/`](companion)) — same native engine, same
multi-track/trim/loop/routing/group model, same waveform-based settings editor.

![A Stream Deck page with SAAP Audio keys: a Play Sound key idle and playing with a looping progress ring, a paused key, live volume, Set Loop Point in/out, Exit Loop, Stop all, and Skip forward](.github/readme/keys-overview.png)

## Install — Stream Deck plugin

1. Download **`com.saap.audio.streamDeckPlugin`** from the [latest release](../../releases/latest).
2. Double-click it: the Stream Deck app installs the plugin.
3. Look for the **SAAP Audio** category in the action list.

Requirements: macOS 12+ (Apple Silicon and Intel) or Windows 10/11, and Stream Deck 6.5 or later.

> **macOS:** the audio engine is not notarized by Apple. The plugin removes the quarantine flag itself on startup,
> but if macOS still shows "Apple could not verify saap-engine", open System Settings → Privacy & Security
> and click "Open Anyway".

### Windows

The same `com.saap.audio.streamDeckPlugin` file installs on both macOS and Windows. It uses WASAPI (no ASIO) and
has not yet been validated on real audio hardware: feedback is welcome. The plugin logs are in
`%appdata%\Elgato\StreamDeck\Plugins\com.saap.audio.sdPlugin\logs`.

## Install — Bitfocus Companion module

1. Download **`saap-audio-<version>.tgz`** from the same [latest release](../../releases/latest).
2. In Companion, import it as a module (or point a "Developer modules path" at a source checkout — see
   [`companion/README.md`](companion/README.md)).
3. Add a "SAAP Audio" connection; its status shows a URL once it starts — that's the web page where sounds are
   actually configured (files, tracks, waveform, trim/loop, routing, groups), since Companion's own action editor
   only offers plain fields. See the module's own **Help** page (in Companion) or
   [`companion/companion/HELP.md`](companion/companion/HELP.md) for the full rundown of actions, feedbacks and
   ready-made presets.

Requirements: same as the plugin (macOS 12+ or Windows 10/11) plus Companion itself; no Stream Deck needed.

## Using the Stream Deck plugin

The plugin adds several kinds of key/dial to the **SAAP Audio** category. **Play Sound** is the actual player;
everything else is a *control* that acts on sounds already started by a Play Sound key, rather than playing
anything itself.

- **Play Sound**: holds up to 6 tracks. Assign a file to track 1 (and, optionally, more files to tracks 2-6) in
  its settings, then press the key — every track with a file starts together, in sync to the millisecond. Each
  track has its own output, volume, fades, and trim/loop points, set from that same panel or drawn directly on
  its waveform.

  The panel in the Stream Deck app is narrow: press **Open large editor** at its top to get the same settings in
  your browser, laid out wide — a much bigger waveform to place trim and loop points on, and all six tracks side
  by side. Both stay in sync (a change in one shows up in the other), and the editor has a **Browse…** button that
  opens the system's file dialog. It is served by the plugin on `127.0.0.1` only, behind a random per-launch token,
  and stops working when Stream Deck quits.

  ![The Play Sound settings panel: a file loaded, its waveform with trim and loop markers, output routing, volume, fades, and loop points](.github/readme/play-settings.png)
- **Groups** are how a control reaches the right sounds. Give a Play Sound key a group name in its settings; a
  control key (Volume, Skip forward/back, Set Loop Point, Exit Loop, Stop all) set to that same group only
  affects sounds started from keys in that group, while one left on "all sounds" reaches everything currently
  playing. This is what lets, say, one Stop All key fade out just the "ambience" group while a separate key stops
  everything.
- **Routing**: each track is sent to one or several outputs — an audio interface, and a specific stereo pair or
  single channel on it — so a single key press can, for instance, send a click track to a monitor mix while the
  rest goes to the main output.
- **Looping**: trim in/out crops the file to a range; loop in/out (independent from trim) marks a sub-range
  within it that repeats, with an optional crossfade to mask the seam. Set either by typing seconds into the
  panel, by dragging the handles on the waveform, or — while the track is already playing — by pressing
  **Set Loop Point** to capture the current position live, so a loop can be tapped in by ear instead of by
  number.

### Stream Deck plugin: every action

- **Play sound** (key):
  - up to 6 tracks per key, started together within a millisecond (mono or stereo files);
  - per-track routing to one or **several outputs** (audio interface + stereo pair or single channel);
  - fade in / fade out, **trim in / trim out** points placed on a waveform, loop;
  - **loop in / loop out** points, independent from trim: play from trim-in, loop between loop-in and
    loop-out, then (once **Exit Loop** is pressed) finish the current pass and play through to trim-out
    instead of wrapping again — handy for a musical intro/loop/outro structure;
  - **loop crossfade**: on every wrap, blends the tail past loop-out into the head at loop-in instead of a
    hard cut, so the loop's rhythmic length stays exact — masks the click of a loop point that isn't a
    zero crossing, more musically than a fade to silence and back;
  - live volume per track, countdown or elapsed time with a progress ring on the key;
  - key behavior while playing: stop (with fade), pause / resume, or restart;
  - track 1 can act as a **master**: its trim points, loop points (independently linkable), fades
    (including the loop fade) and volume can be linked to the other tracks.
- **Volume** (key or dial): master volume or per-group volume, mute. Dial: rotate = volume, press = mute.
- **Skip forward / back** (key or dial): jump within running playbacks; all tracks move together and stay in sync.
- **Set Loop Point** (key): marks the current playback position as the loop-in or loop-out point, live, for every
  running track matching a group (all sounds, or one group) — and turns Loop on for it. Does nothing if nothing
  matching is playing.
- **Exit Loop** (key): stops looping playbacks (all, or one group) — each finishes its current pass, then plays
  through to its trim-out point. Has no effect on a track that isn't looping.
- **Stop all** (key): all sounds or one group, with a fade or an immediate cut. Give each button its own name to
  have several stop buttons.
- **Remote Trigger** (key): triggers a Play key, or a group control (Volume, Skip, Stop all, Exit loop, Set loop
  point), on **another computer's** SAAP Audio over the local network — for a second Stream Deck on a different
  machine. That other computer needs *Network control* turned on (Play key settings, bottom section) with a
  passphrase; enter its address, port and that same passphrase in the Remote Trigger key, then **Test connection**
  to pick a target key from a list instead of typing an id. Off by default, and nothing listens on the network
  until *Network control* is turned on and a passphrase is set.
- **Update check**: the plugin looks on GitHub for a newer release (one anonymous request at startup, then daily;
  pre-releases are ignored) and shows a bar at the top of the settings panel and of the large editor, with
  **Install** (downloads the package and opens it — Stream Deck asks you to confirm) and **What's new**. It can be
  switched off in the panel's *Updates* section.
- **Groups**: a free name per sound; "stop the group's other sounds on start" gives exclusive playback.

## Using the Companion module

Companion buttons only offer plain fields (text, number, checkbox, dropdown) — no waveform, no native file
dialog. So all the rich setup lives on one local web page the module serves itself, and a button just references
a sound there by an id you choose; several buttons can share the same id.

1. Add the **SAAP Audio** connection. Its status shows a URL once it starts (`http://127.0.0.1:PORT/TOKEN/`) —
   or add the **Open Sound Editor** action to any button and press it for one-click access instead.
2. On that page, click **+ New sound**, give it an id (e.g. `applause`), and set up its file, output routing,
   volume, fades, and trim/loop points — same waveform, same multi-output checkbox picker, drag-and-drop, and a
   native **Browse…** dialog as the Stream Deck plugin's own large editor. A **Clear** button next to the file
   field removes it and its trim/loop points without touching output/volume/fades.
3. On a button, add the **Play Sound** action and type that same id into its **Sound** field — or drag in the
   ready-made **Play Sound** preset (Presets tab), styled like the plugin's own key and already wired with live
   feedbacks, and just fill in the Sound id.
4. Adding a second action or feedback to that same button (Stop, a feedback, …)? Click its **Learn** button
   instead of retyping the id — it copies whatever Sound id the button's other action(s) already use.

### Companion module: every action

- **Open Sound Editor**: opens the web editor in the default browser.
- **Play Sound**: starts every track of a sound that has a file, all in sync. A second press while it's already
  playing restarts, stops, or pauses/resumes it, per that sound's own "On press while playing" setting.
- **Stop**: one sound by id, or every sound when left blank (same fade either way).
- **Pause / Resume**: one sound by id.
- **Stop All**, **Skip forward / back**, **Exit Loop**: target a group (set per-sound in the web editor), or
  every sound when left blank.
- **Set Loop Point**: captures the current position as the loop-in or loop-out point of one sound by id, or of
  every sound currently playing when left blank (each at its own position).
- **Set Volume (master / group)**: set, nudge, or mute the master level or a named group's level.

### Companion module: feedbacks and presets

- **Sound Title + Time**: the sound's name plus a live elapsed/remaining countdown and a PAUSE/LOOP indicator,
  refreshed about 10×/s — the closest match to the plugin's own key. **Sound Title** alone is also available for
  a plainer button, alongside separate **Sound is playing** / **Sound is paused** color feedbacks.
- **Presets** (Presets tab): one ready-made button per action above, styled like the plugin's own keys — dark
  idle, green while playing, amber while paused, blue for loop/skip, coral for Stop All. Drag one onto a button
  and fill in a Sound or Group id.
- **Update check**: the web editor shows a banner when a newer release is available (same GitHub check as the
  plugin, once a day) — but since Companion can't self-install a module, it just links to the release page.

Known limitations vs. the plugin: no native file picker inside Companion's own action fields (type or paste a
path, or use the web editor's Browse…/drag-and-drop instead); macOS/Windows only, same as the plugin; the web
editor only works from the machine Companion itself runs on. See [`companion/companion/HELP.md`](companion/companion/HELP.md)
for the full detail on every action/feedback.

## Architecture

- [`engine/`](engine) — native macOS audio engine in Objective-C (one `AVAudioEngine` per playback, channel routing
  through a CoreAudio channel map).
- [`engine-rs/`](engine-rs) — Windows audio engine in Rust (`cpal` + `symphonia`, WASAPI). It also builds on macOS,
  which is how it is tested.
- [`plugin/`](plugin) — TypeScript plugin (Elgato SDK): it launches the engine, drives keys and dials, and serves the
  settings panels.
- [`companion/`](companion) — the Bitfocus Companion module: embeds the same two engines directly (no Stream Deck
  or plugin involved), and serves its own local web page for the actual sound settings, since Companion actions
  only offer plain fields.

Both engines speak the same protocol: one JSON command per line on stdin, one JSON event per line on stdout.
The plugin and the Companion module each pick `saap-engine` (macOS) or `saap-engine.exe` (Windows) at runtime.

## Build

```bash
./engine/build.sh                            # macOS engine → plugin/com.saap.audio.sdPlugin/bin/saap-engine
cd engine-rs && cargo build --release        # Windows engine (run on Windows, or use the CI)
cd plugin && npm install && npm run build    # bundles bin/plugin.js
```

The settings panels in `plugin/com.saap.audio.sdPlugin/ui/` are generated by `plugin/tools/gen-inspector.py`.

## Package and release

```bash
./package.sh              # builds dist/com.saap.audio.streamDeckPlugin (macOS engine only, when run locally)
cd companion && ./build.sh # builds companion/saap-audio-<version>.tgz
```

Versions follow a calendar scheme, `YY.MM.N` — year, month, and the number of commits on `main` so far that month
(resets every month) — shared by the plugin and the Companion module, which release together.

Pushing a tag such as `v26.9.1` runs the [GitHub Actions workflow](.github/workflows/release.yml), which builds
both engines, assembles the Stream Deck package for macOS and Windows and the Companion module's `.tgz`, and
attaches both to the one release. A tag with a dash (`v26.9.1-beta.1`) is published as a pre-release.

## Development install

```bash
# macOS
ln -s "$PWD/plugin/com.saap.audio.sdPlugin" "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.saap.audio.sdPlugin"
```

Then quit and restart the Stream Deck app. Logs are in `com.saap.audio.sdPlugin/logs/`.

For the Companion module, see [`companion/README.md`](companion/README.md) — Companion loads it straight from a
source checkout via its "Developer modules path" setting, no symlink needed.

## License

[MIT](LICENSE) © 2026 Florian Sauvé. Third-party software included in or used to build the plugin is listed, with
its license, in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
