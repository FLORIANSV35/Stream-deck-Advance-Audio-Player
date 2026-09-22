#!/usr/bin/env python3
"""Generates the settings panels (ui/*.html): same look, repeated tracks."""
import os
UI = os.path.join(os.path.dirname(__file__), "..", "com.saap.audio.sdPlugin", "ui")
MAX_TRACKS = 6
AUDIO = ".wav,.mp3,.aif,.aiff,.m4a,.aac,.flac,.caf,.mp4"
LOGO = '''<svg viewBox="0 0 36 36"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#22c55e"/></linearGradient></defs>
<rect width="36" height="36" rx="9" fill="#1d2027"/><g fill="url(#lg)"><rect x="7" y="15" width="3" height="6" rx="1.5"/><rect x="12" y="10" width="3" height="16" rx="1.5"/><rect x="17" y="6" width="3" height="24" rx="1.5"/><rect x="22" y="12" width="3" height="12" rx="1.5"/><rect x="27" y="16" width="3" height="4" rx="1.5"/></g></svg>'''

def page(title, subtitle, body, scripts=()):
    tags = "".join(f'\n  <script src="{s}"></script>' for s in scripts)
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{title}</title>
  <script src="sdpi-components.js"></script>
  <link rel="stylesheet" href="saap.css" />
</head>
<body>
  <header class="hero">{LOGO}<div><h1>{title}</h1><p>{subtitle}</p></div></header>
{body}{tags}
</body>
</html>
'''

def item(label, inner, extra=""):
    return f'    <sdpi-item label="{label}"{extra}>{inner}</sdpi-item>\n'

def card(badge, title, body, *, open=False, cls="", sub="", tag="", subattr=""):
    sub_html = f'<span class="sub"{subattr}>{sub}</span>' if sub or subattr else ""
    tag_html = f'<span class="tag">{tag}</span>' if tag else ""
    return f'''  <details class="card {cls}"{" open" if open else ""}>
    <summary><span class="badge">{badge}</span><span class="meta"><span class="title">{title}</span>{sub_html}</span>{tag_html}</summary>
    <div class="body">
{body}    </div>
  </details>
'''

def track_fields(n):
    k = lambda name: name if n == 1 else f"{name}{n}"
    link = lambda kind: "" if n == 1 else f' data-link="{kind}"'
    out = item("File", f'<sdpi-file setting="{k("file")}" accept="{AUDIO}"></sdpi-file>')
    out += item("Waveform", f'<div class="wave" data-n="{n}"></div>')
    out += item("Outputs", f'<div class="outpick" data-n="{n}"></div>')
    out += item("Volume", f'<sdpi-range setting="{k("volume")}" min="0" max="100" step="1" default="100" showlabels></sdpi-range>', link("volume"))
    out += item("Fade in (s)", f'<sdpi-range setting="{k("fadeIn")}" min="0" max="10" step="0.1" default="0" showlabels></sdpi-range>', link("fades"))
    out += item("Fade out (s)", f'<sdpi-range setting="{k("fadeOut")}" min="0" max="10" step="0.1" default="0" showlabels></sdpi-range>', link("fades"))
    out += item("Trim in (s)", f'<sdpi-textfield setting="{k("trimIn")}" placeholder="0 = start of file" pattern="^[0-9]*[.,]?[0-9]*$"></sdpi-textfield>', link("cut"))
    out += item("Trim out (s)", f'<sdpi-textfield setting="{k("trimOut")}" placeholder="0 = end of file" pattern="^[0-9]*[.,]?[0-9]*$"></sdpi-textfield>', link("cut"))
    out += item("Loop", f'<sdpi-checkbox setting="{k("loop")}" label="Loop playback"></sdpi-checkbox>')
    out += item("Loop in (s)", f'<sdpi-textfield setting="{k("loopIn")}" placeholder="0 = start of trim" pattern="^[0-9]*[.,]?[0-9]*$"></sdpi-textfield>', f' data-loopfield="{n}"' + link("loop"))
    out += item("Loop out (s)", f'<sdpi-textfield setting="{k("loopOut")}" placeholder="0 = end of trim" pattern="^[0-9]*[.,]?[0-9]*$"></sdpi-textfield>', f' data-loopfield="{n}"' + link("loop"))
    out += item("Loop crossfade (s)", f'<sdpi-range setting="{k("loopFade")}" min="0" max="10" step="0.1" default="0" showlabels></sdpi-range>', f' data-loopfield="{n}"' + link("fades"))
    return out

def play():
    body = '  <sdpi-note>Each track has its own file and outputs. One press starts every track that has a file, exactly at the same time.</sdpi-note>\n'
    body += '  <h2 class="section">Tracks</h2>\n'
    for n in range(1, MAX_TRACKS + 1):
        body += card(n, f"Track {n}", track_fields(n), open=(n == 1),
                     cls="" if n == 1 else "slave", tag="MASTER" if n == 1 else "",
                     subattr=f' data-file="{n}"')
    body += '  <h2 class="section">Linking</h2>\n'
    body += card("⛓", "Track linking", 
        item("Trim", '<sdpi-checkbox setting="linkCut" label="Tracks 2-6: same trim points as track 1"></sdpi-checkbox>') +
        item("Fades", '<sdpi-checkbox setting="linkFades" label="Tracks 2-6: same fades as track 1"></sdpi-checkbox>') +
        item("Volume", '<sdpi-checkbox setting="linkVolume" label="Tracks 2-6: same volume as track 1"></sdpi-checkbox>') +
        item("Loop points", '<sdpi-checkbox setting="linkLoop" label="Tracks 2-6: same loop in/out as track 1"></sdpi-checkbox>'),
        cls="plain", sub="Track 1 is the master")
    body += '  <h2 class="section">Key</h2>\n'
    body += card("◉", "Behavior", 
        item("Display name", '<sdpi-textfield setting="label" placeholder="Track 1 file name by default" maxlength="24"></sdpi-textfield>') +
        item("Press while playing", '''<sdpi-select setting="mode" default="stop">
        <option value="stop">Stop (with fade out)</option>
        <option value="pause">Pause / resume</option>
        <option value="restart">Restart from the beginning</option>
      </sdpi-select>''') +
        item("Display", '<sdpi-checkbox setting="countdown" label="Countdown (time remaining)" default="true"></sdpi-checkbox>') +
        item("Group", '<sdpi-select setting="group" datasource="getGroupsPlay" loading="Loading…" default="none" placeholder="No group"></sdpi-select>') +
        item("New group", '<sdpi-textfield setting="newGroup" placeholder="Type a name, then press Enter" maxlength="20"></sdpi-textfield>') +
        item("", '<sdpi-checkbox setting="stopOthers" label="Stop other sounds of the same group on start"></sdpi-checkbox>'),
        open=True, cls="plain")
    return page("Play sounds", "Up to 6 tracks, synchronized to the millisecond", body, ["waveform.js", "outputs.js", "links.js"])

def volume():
    body = '  <h2 class="section">Setting</h2>\n' + card("♪", "Live volume",
        item("Target", '<sdpi-select setting="target" datasource="getGroupsVolume" loading="Loading…" default="*" placeholder="Master (all sounds)"></sdpi-select>') +
        item("Key", '''<sdpi-select setting="mode" default="up">
        <option value="up">Volume +</option>
        <option value="down">Volume −</option>
        <option value="mute">Mute / unmute</option>
        <option value="set">Set to a value</option>
      </sdpi-select>''') +
        item("Step (%)", '<sdpi-range setting="step" min="1" max="20" step="1" default="5" showlabels></sdpi-range>') +
        item("Fixed value (%)", '<sdpi-range setting="value" min="0" max="100" step="1" default="100" showlabels></sdpi-range>'),
        open=True, cls="plain")
    body += '  <sdpi-note>On a dial: rotate = volume, press or touch = mute. The step applies to each notch.</sdpi-note>\n'
    return page("Volume", "Master or per group of sounds", body)

def looppoint():
    body = '  <h2 class="section">Set loop point</h2>\n' + card("[", "Set loop point",
        item("Display name", '<sdpi-textfield setting="label" placeholder="Loop in / Loop out" maxlength="24"></sdpi-textfield>') +
        item("Group", '<sdpi-select setting="group" datasource="getGroupsStop" loading="Loading…" default="*" placeholder="All sounds"></sdpi-select>') +
        item("Which point", '''<sdpi-select setting="which" default="in">
        <option value="in">Loop in</option>
        <option value="out">Loop out</option>
      </sdpi-select>'''),
        open=True, cls="plain")
    body += '  <sdpi-note>Marks the current playback position as the loop-in or loop-out point, live, for every running track matching the group above (one point per track, even if it plays on several outputs) — and turns Loop on for it. Does nothing if nothing matching is playing.</sdpi-note>\n'
    return page("Set loop point", "Mark loop in / out live, during playback", body)

def exitloop():
    body = '  <h2 class="section">Exit loop</h2>\n' + card("↴", "Exit loop",
        item("Display name", '<sdpi-textfield setting="label" placeholder="Exit loop" maxlength="24"></sdpi-textfield>') +
        item("Group", '<sdpi-select setting="group" datasource="getGroupsStop" loading="Loading…" default="*" placeholder="All sounds"></sdpi-select>'),
        open=True, cls="plain")
    body += '  <sdpi-note>For playbacks that are looping between their loop-in and loop-out points: each one finishes its current pass, then plays through to its trim-out point instead of wrapping back. Has no effect on a track that isn\'t looping.</sdpi-note>\n'
    return page("Exit loop", "Stop looping, play through to the end", body)

def stopall():
    body = '  <h2 class="section">Stop</h2>\n' + card("■", "Stop all",
        item("Display name", '<sdpi-textfield setting="label" placeholder="Stop all" maxlength="24"></sdpi-textfield>') +
        item("Group", '<sdpi-select setting="group" datasource="getGroupsStop" loading="Loading…" default="*" placeholder="All sounds"></sdpi-select>') +
        item("Stop", '''<sdpi-select setting="mode" default="fade">
        <option value="fade">With fade</option>
        <option value="cut">Cut immediately</option>
      </sdpi-select>''') +
        item("Fade duration (s)", '<sdpi-range setting="fade" min="0.1" max="10" step="0.1" default="1.5" showlabels></sdpi-range>'),
        open=True, cls="plain")
    return page("Stop all", "All sounds, or one group", body)

def seek():
    body = '  <h2 class="section">Seeking</h2>\n' + card("»", "Skip forward / back",
        item("Sounds affected", '<sdpi-select setting="group" datasource="getGroupsStop" loading="Loading…" default="*" placeholder="All sounds"></sdpi-select>') +
        item("Key: direction", '''<sdpi-select setting="direction" default="forward">
        <option value="forward">Forward</option>
        <option value="back">Back</option>
      </sdpi-select>''') +
        item("Key: skip (s)", '<sdpi-range setting="seconds" min="1" max="60" step="1" default="10" showlabels></sdpi-range>') +
        item("Dial: skip per notch (s)", '<sdpi-range setting="dialStep" min="1" max="30" step="1" default="2" showlabels></sdpi-range>'),
        open=True, cls="plain")
    body += '  <sdpi-note>Acts on all playbacks of the chosen group, together and without offset. Dial: rotate = scrub, press or touch = pause / resume.</sdpi-note>\n'
    return page("Skip forward / back", "Move within the playback", body)

for name, fn in [("play", play), ("volume", volume), ("stopall", stopall), ("seek", seek), ("exitloop", exitloop), ("looppoint", looppoint)]:
    with open(os.path.join(UI, f"{name}.html"), "w") as f:
        f.write(fn())
print("ok")
