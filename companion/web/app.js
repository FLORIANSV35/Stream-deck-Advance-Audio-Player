// The only settings UI this module has (see companion/src/editor-server.ts and companion/HELP.md): lists every
// configured sound, and edits its tracks/trim/loop/routing/groups — a Companion "Play Sound" action just
// references a sound here by its id.
import { createOutputPicker } from "./outpick.js";
import { createWaveform } from "./waveform.js";

const MAX_TRACKS = 6;
const num = (v, d = 0) => {
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : d;
};
const fieldName = (base, n) => (n === 1 ? base : base + n);

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.error) body.error = `HTTP ${res.status}`;
  return body;
}

let sounds = {};
let selectedId = null;
let outputsCache = null;
let currentTracks = [];
let waveforms = [];
let saveTimer = null;

const soundlistEl = document.getElementById("soundlist");
const mainEl = document.getElementById("main");

async function loadSounds() {
  sounds = await api("api/sounds");
  renderSidebar();
}

function renderSidebar() {
  soundlistEl.innerHTML = "";
  for (const id of Object.keys(sounds).sort((a, b) => a.localeCompare(b))) {
    const row = document.createElement("div");
    row.className = "sound-item" + (id === selectedId ? " on" : "");
    row.dataset.id = id;
    row.innerHTML = '<span class="dot"></span><span class="name"></span><span class="del" title="Delete">✕</span>';
    row.querySelector(".name").textContent = sounds[id].label || id;
    row.addEventListener("click", (e) => { if (!e.target.classList.contains("del")) select(id); });
    row.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete sound "${id}"?`)) return;
      await api(`api/sounds/${encodeURIComponent(id)}`, { method: "DELETE" });
      delete sounds[id];
      if (selectedId === id) {
        selectedId = null;
        mainEl.innerHTML = '<div class="empty">Select a sound on the left, or create one.</div>';
      }
      renderSidebar();
    });
    soundlistEl.append(row);
  }
}

function select(id) {
  selectedId = id;
  renderSidebar();
  renderSound(id);
}

function scheduleSave(id, s) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api(`api/sounds/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(s) }), 300);
}

function fieldsOfTrack(s, n) {
  return {
    file: s[fieldName("file", n)] || "",
    outputs: Array.isArray(s[fieldName("outputs", n)]) ? s[fieldName("outputs", n)] : [],
    volume: s[fieldName("volume", n)] ?? 100,
    loop: !!s[fieldName("loop", n)],
    fadeIn: s[fieldName("fadeIn", n)] ?? 0,
    fadeOut: s[fieldName("fadeOut", n)] ?? 0,
    trimIn: s[fieldName("trimIn", n)] ?? "",
    trimOut: s[fieldName("trimOut", n)] ?? "",
    loopIn: s[fieldName("loopIn", n)] ?? "",
    loopOut: s[fieldName("loopOut", n)] ?? "",
    loopFade: s[fieldName("loopFade", n)] ?? "",
  };
}

async function renderSound(id) {
  const s = sounds[id] ?? {};
  if (!outputsCache) outputsCache = await api("api/outputs");
  mainEl.innerHTML = "";
  currentTracks = [];
  waveforms = [];

  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = '<input class="label" />';
  mainEl.append(head);
  const labelInput = head.querySelector(".label");
  labelInput.placeholder = id;
  labelInput.value = s.label || "";
  labelInput.addEventListener("input", () => { s.label = labelInput.value; scheduleSave(id, s); renderSidebar(); });

  const rowfields = document.createElement("div");
  rowfields.className = "rowfields";
  rowfields.innerHTML = `
    <label class="field">Group<input class="f-group" placeholder="(none)" /></label>
    <label class="field">On press while playing<select class="f-mode">
      <option value="restart">Restart</option>
      <option value="stop">Stop</option>
      <option value="pause">Pause/Resume</option>
    </select></label>
    <label class="field row"><input type="checkbox" class="f-stopOthers" /> Stop other sounds in this group first</label>`;
  mainEl.append(rowfields);
  const groupInput = rowfields.querySelector(".f-group");
  groupInput.value = s.group || "";
  groupInput.addEventListener("change", () => { s.group = groupInput.value; scheduleSave(id, s); });
  const modeSelect = rowfields.querySelector(".f-mode");
  modeSelect.value = s.mode || "restart";
  modeSelect.addEventListener("change", () => { s.mode = modeSelect.value; scheduleSave(id, s); });
  const stopOthersInput = rowfields.querySelector(".f-stopOthers");
  stopOthersInput.checked = !!s.stopOthers;
  stopOthersInput.addEventListener("change", () => { s.stopOthers = stopOthersInput.checked; scheduleSave(id, s); });

  const linkrow = document.createElement("div");
  linkrow.className = "linkrow";
  linkrow.innerHTML = `Tracks 2-6 can each follow track 1's:
    <label class="field row"><input type="checkbox" class="f-linkCut" /> Trim</label>
    <label class="field row"><input type="checkbox" class="f-linkFades" /> Fades</label>
    <label class="field row"><input type="checkbox" class="f-linkVolume" /> Volume</label>
    <label class="field row"><input type="checkbox" class="f-linkLoop" /> Loop points</label>`;
  mainEl.append(linkrow);
  for (const flag of ["linkCut", "linkFades", "linkVolume", "linkLoop"]) {
    const el = linkrow.querySelector(`.f-${flag}`);
    el.checked = !!s[flag];
    el.addEventListener("change", () => { s[flag] = el.checked; scheduleSave(id, s); });
  }

  for (let n = 1; n <= MAX_TRACKS; n++) renderTrack(id, s, n);
}

function renderTrack(soundId, s, n) {
  const f = fieldsOfTrack(s, n);
  const details = document.createElement("details");
  details.className = "card";
  if (n === 1) details.open = true;
  details.innerHTML = `
    <summary><span class="badge">${n}</span><span class="title">Track ${n}</span></summary>
    <div class="body">
      <div class="filerow">
        <input class="f-file" placeholder="Path to an audio file" />
        <button type="button" class="browse">Browse…</button>
        <button type="button" class="clear-file">Clear</button>
      </div>
      <div class="wave"><canvas></canvas>
        <div class="wave-controls">
          <input type="range" class="wz-zoom" min="0" max="100" value="0" step="1" disabled title="Zoom">
          <input type="range" class="wz-pos" min="0" max="100" value="0" step="1" disabled title="Position">
          <button type="button" class="wz-fit">Fit</button>
        </div>
        <div class="wave-info"></div>
      </div>
      <div class="grid3">
        <div class="field"><span>Output</span><div class="outpick"></div></div>
        <label class="field">Volume (0-200%)<input class="f-volume" type="number" min="0" max="200" step="1" /></label>
        <label class="field row"><input type="checkbox" class="f-loop" /> Loop</label>
      </div>
      <div class="grid3">
        <label class="field">Fade in (s)<input class="f-fadeIn" type="number" min="0" step="0.1" /></label>
        <label class="field">Fade out (s)<input class="f-fadeOut" type="number" min="0" step="0.1" /></label>
        <label class="field">Trim in (s)<input class="f-trimIn" type="number" min="0" step="0.01" /></label>
      </div>
      <div class="grid3">
        <label class="field">Trim out (s, 0 = end)<input class="f-trimOut" type="number" min="0" step="0.01" /></label>
        <label class="field loopfield">Loop in (s)<input class="f-loopIn" type="number" min="0" step="0.01" /></label>
        <label class="field loopfield">Loop out (s, 0 = trim end)<input class="f-loopOut" type="number" min="0" step="0.01" /></label>
      </div>
      <div class="grid3">
        <label class="field loopfield">Loop crossfade (s)<input class="f-loopFade" type="number" min="0" step="0.01" /></label>
      </div>
    </div>`;
  mainEl.append(details);

  const outPicker = createOutputPicker(details.querySelector(".outpick"), f.outputs, (v) => {
    s[fieldName("outputs", n)] = v;
    scheduleSave(soundId, s);
  });
  outPicker.setItems(outputsCache);

  const fileInput = details.querySelector(".f-file"); fileInput.value = f.file;
  const volumeInput = details.querySelector(".f-volume"); volumeInput.value = f.volume;
  const loopInput = details.querySelector(".f-loop"); loopInput.checked = f.loop;
  const fadeInInput = details.querySelector(".f-fadeIn"); fadeInInput.value = f.fadeIn;
  const fadeOutInput = details.querySelector(".f-fadeOut"); fadeOutInput.value = f.fadeOut;
  const trimInInput = details.querySelector(".f-trimIn"); trimInInput.value = f.trimIn;
  const trimOutInput = details.querySelector(".f-trimOut"); trimOutInput.value = f.trimOut;
  const loopInInput = details.querySelector(".f-loopIn"); loopInInput.value = f.loopIn;
  const loopOutInput = details.querySelector(".f-loopOut"); loopOutInput.value = f.loopOut;
  const loopFadeInput = details.querySelector(".f-loopFade"); loopFadeInput.value = f.loopFade;

  const loopfields = details.querySelectorAll(".loopfield");
  const updateLoopVisibility = () => loopfields.forEach((el) => (el.hidden = !loopInput.checked));
  updateLoopVisibility();

  const track = {
    file: "", duration: 0, peaks: null, msg: "Choose a file",
    tin: num(f.trimIn), tout: num(f.trimOut),
    loopOn: f.loop, lin: num(f.loopIn), lout: num(f.loopOut),
    viewStart: 0, viewEnd: 0, playing: false, pos: 0,
  };
  currentTracks[n] = track;

  const fetchPeaks = (file, nres, from, to) =>
    api("api/peaks", { method: "POST", body: JSON.stringify({ file, n: nres, from, to }) });

  const wf = createWaveform(details.querySelector("canvas"), details.querySelector(".wave-info"), track, {
    fetchPeaks: (nres, from, to) => fetchPeaks(track.file, nres, from, to),
    onCommit: () => {
      trimInInput.value = track.tin.toFixed(2);
      trimOutInput.value = track.tout > track.duration - 0.01 ? "" : track.tout.toFixed(2);
      loopInInput.value = track.lin < 0.01 ? "" : track.lin.toFixed(2);
      loopOutInput.value = track.lout > track.duration - 0.01 || track.lout < 0.01 ? "" : track.lout.toFixed(2);
      save();
    },
  });
  waveforms[n] = wf;

  function save() {
    s[fieldName("file", n)] = fileInput.value;
    s[fieldName("volume", n)] = num(volumeInput.value, 100);
    s[fieldName("loop", n)] = loopInput.checked;
    s[fieldName("fadeIn", n)] = num(fadeInInput.value);
    s[fieldName("fadeOut", n)] = num(fadeOutInput.value);
    s[fieldName("trimIn", n)] = trimInInput.value;
    s[fieldName("trimOut", n)] = trimOutInput.value;
    s[fieldName("loopIn", n)] = loopInInput.value;
    s[fieldName("loopOut", n)] = loopOutInput.value;
    s[fieldName("loopFade", n)] = loopFadeInput.value;
    scheduleSave(soundId, s);
  }

  function loadFile(path) {
    fileInput.value = path;
    save();
    wf.setFile(path, () => fetchPeaks(path, 600, 0, 0));
  }

  fileInput.addEventListener("change", () => loadFile(fileInput.value));
  details.querySelector(".browse").addEventListener("click", async () => {
    const r = await api("api/browse", { method: "POST" });
    if (r.path) loadFile(r.path);
  });
  // removes this track's file and its trim/loop points; output, volume and fades are left alone — those are
  // the track's own routing/level, not tied to which file happens to be loaded on it (same as the plugin's own
  // "Clear" button)
  details.querySelector(".clear-file").addEventListener("click", () => {
    fileInput.value = ""; loopInput.checked = false;
    trimInInput.value = ""; trimOutInput.value = ""; loopInInput.value = ""; loopOutInput.value = ""; loopFadeInput.value = "";
    track.tin = 0; track.tout = 0; track.loopOn = false; track.lin = 0; track.lout = 0;
    updateLoopVisibility();
    save();
    wf.setFile("", () => Promise.resolve(undefined));
  });
  volumeInput.addEventListener("input", save);
  loopInput.addEventListener("change", () => { track.loopOn = loopInput.checked; updateLoopVisibility(); save(); wf.draw(); });
  fadeInInput.addEventListener("input", save);
  fadeOutInput.addEventListener("input", save);
  trimInInput.addEventListener("change", () => { track.tin = num(trimInInput.value); wf.draw(); save(); });
  trimOutInput.addEventListener("change", () => { track.tout = num(trimOutInput.value); wf.draw(); save(); });
  loopInInput.addEventListener("change", () => { track.lin = num(loopInInput.value); wf.draw(); save(); });
  loopOutInput.addEventListener("change", () => { track.lout = num(loopOutInput.value); wf.draw(); save(); });
  loopFadeInput.addEventListener("input", save);

  const filerow = details.querySelector(".filerow");
  filerow.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); filerow.classList.add("dropping"); } });
  filerow.addEventListener("dragleave", () => filerow.classList.remove("dropping"));
  filerow.addEventListener("drop", async (e) => {
    filerow.classList.remove("dropping");
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const res = await fetch(`api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    const body = await res.json().catch(() => ({}));
    if (body.path) loadFile(body.path);
  });

  if (f.file) wf.setFile(f.file, () => fetchPeaks(f.file, 600, 0, 0));
}

async function renderMixer() {
  const groups = await api("api/groups");
  const levels = await api("api/mixer");
  mainEl.innerHTML = '<div class="head"><input class="label" value="Mixer" disabled /></div>';
  for (const target of ["*", ...groups]) {
    const level = levels[target] || { pct: 100, muted: false };
    const row = document.createElement("div");
    row.className = "mixer-row";
    row.innerHTML = `
      <span class="name">${target === "*" ? "Master" : target}</span>
      <input type="range" min="0" max="100" value="${level.pct}" />
      <span class="pct">${level.pct}%</span>
      <label class="field row"><input type="checkbox" ${level.muted ? "checked" : ""} /> Mute</label>`;
    mainEl.append(row);
    const range = row.querySelector("input[type=range]");
    const pctEl = row.querySelector(".pct");
    const muteEl = row.querySelector("input[type=checkbox]");
    range.addEventListener("input", () => { pctEl.textContent = `${range.value}%`; });
    range.addEventListener("change", () => api(`api/mixer/${encodeURIComponent(target)}`, { method: "PUT", body: JSON.stringify({ pct: Number(range.value) }) }));
    muteEl.addEventListener("change", () => api(`api/mixer/${encodeURIComponent(target)}`, { method: "PUT", body: JSON.stringify({ muted: muteEl.checked }) }));
  }
}

document.getElementById("addSound").addEventListener("click", async () => {
  const id = prompt('Id for the new sound — this is what you\'ll type into a "Play Sound" action\'s Sound field:');
  const trimmed = id?.trim();
  if (!trimmed) return;
  if (!sounds[trimmed]) {
    sounds[trimmed] = {};
    await api(`api/sounds/${encodeURIComponent(trimmed)}`, { method: "PUT", body: JSON.stringify({}) });
  }
  renderSidebar();
  select(trimmed);
});
document.getElementById("openMixer").addEventListener("click", () => { selectedId = null; renderSidebar(); renderMixer(); });

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}${location.pathname}`);
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.event === "position") {
      if (m.soundId === selectedId && currentTracks[m.track]) {
        currentTracks[m.track].playing = m.playing;
        currentTracks[m.track].pos = m.pos;
        waveforms[m.track]?.draw();
      }
    } else if (m.event === "changed") {
      soundlistEl.querySelector(`[data-id="${CSS.escape(m.soundId)}"]`)?.classList.toggle("playing", !!m.playing);
    }
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
}

loadSounds();
connectWS();
