// Waveform with trim handles, loop markers, zoom, and a live playback cursor. Adapted from the Stream Deck
// plugin's own waveform.js: same canvas math, but reads/writes a plain track-state object directly instead of
// going through sdpi-components, and fetches peaks via a REST call instead of the plugin's message protocol.
export function createWaveform(canvas, infoEl, track, opts) {
  const ctx = canvas.getContext("2d");
  const GRIP = 12;
  const LOOP_BAND = 16;
  const fmt = (s) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
  };

  const outTime = () => (track.tout > 0 && track.tout < track.duration ? track.tout : track.duration);
  const loopOutEff = () => (track.lout > 0 && track.lout < outTime() ? track.lout : outTime());
  const loopInEff = () => Math.max(track.tin, Math.min(track.lin, loopOutEff()));

  const viewLen = () => Math.max(0.001, track.viewEnd - track.viewStart);
  const xOf = (t) => ((t - track.viewStart) / viewLen()) * canvas.clientWidth;
  const tOf = (x) => Math.max(0, Math.min(track.duration, track.viewStart + (x / canvas.clientWidth) * viewLen()));
  const MIN_VIEW = () => Math.max(0.3, track.duration * 0.005);

  let zoomGen = 0, zoomTimer = null;

  function zoomTo(width, centerT) {
    if (!track.duration) return;
    width = Math.max(MIN_VIEW(), Math.min(track.duration, width));
    let start = centerT - width / 2;
    start = Math.max(0, Math.min(track.duration - width, start));
    track.viewStart = start;
    track.viewEnd = start + width;
    draw();
    scheduleZoomFetch();
  }
  const panTo = (start) => {
    const width = viewLen();
    track.viewStart = Math.max(0, Math.min(track.duration - width, start));
    track.viewEnd = track.viewStart + width;
    draw();
    scheduleZoomFetch();
  };

  // zoom/position sliders: 0-100 mapped onto [MIN_VIEW, duration] and [0, duration-viewLen] respectively,
  // instead of the mouse wheel (fiddly, and fights the page's own scrolling) or a hand-dragged scrollbar
  const zoomPctFromWidth = (width) => {
    const min = MIN_VIEW(), max = track.duration;
    return max > min ? Math.max(0, Math.min(100, Math.round(((max - width) / (max - min)) * 100))) : 0;
  };
  const widthFromZoomPct = (pct) => track.duration - (track.duration - MIN_VIEW()) * (Math.max(0, Math.min(100, pct)) / 100);
  const panPctFromStart = (start) => {
    const span = track.duration - viewLen();
    return span > 0.001 ? Math.max(0, Math.min(100, Math.round((start / span) * 100))) : 0;
  };
  const startFromPanPct = (pct) => (track.duration - viewLen()) * (Math.max(0, Math.min(100, pct)) / 100);

  function scheduleZoomFetch() {
    clearTimeout(zoomTimer);
    if (viewLen() >= track.duration - 0.01 || !track.file) return;
    zoomTimer = setTimeout(async () => {
      const req = ++zoomGen;
      const resolution = Math.max(100, Math.min(4000, Math.round((canvas.clientWidth || 600) * (window.devicePixelRatio || 1))));
      const r = await opts.fetchPeaks(resolution, track.viewStart, track.viewEnd);
      if (req !== zoomGen || !r || r.error) return;
      track.zoomPeaks = r.peaks; track.zoomFrom = r.from; track.zoomTo = r.to;
      draw();
    }, 200);
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!track.peaks) {
      ctx.fillStyle = "#6b7383"; ctx.font = "12px -apple-system, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(track.msg || "Choose a file", w / 2, h / 2 + 4);
      if (infoEl) infoEl.textContent = "";
      syncSliders();
      return;
    }
    const a = xOf(Math.min(track.tin, track.duration)), b = xOf(outTime());
    const on = ctx.createLinearGradient(0, 0, 0, h);
    on.addColorStop(0, "#5eead4"); on.addColorStop(1, "#22c55e");
    const useZoom = track.zoomPeaks && track.zoomPeaks.length && track.viewStart >= track.zoomFrom - 0.001 && track.viewEnd <= track.zoomTo + 0.001;
    const src = useZoom ? track.zoomPeaks : track.peaks;
    const srcFrom = useZoom ? track.zoomFrom : 0;
    const binDur = (useZoom ? track.zoomTo - track.zoomFrom : track.duration) / src.length;
    const first = Math.max(0, Math.floor((track.viewStart - srcFrom) / binDur) - 1);
    const last = Math.min(src.length - 1, Math.ceil((track.viewEnd - srcFrom) / binDur) + 1);
    for (let i = first; i <= last; i++) {
      const x = xOf(srcFrom + i * binDur), xEnd = xOf(srcFrom + (i + 1) * binDur);
      const bw = Math.max(1, xEnd - x);
      if (xEnd < 0 || x > w) continue;
      const amp = Math.max(2, Math.pow(src[i], 0.8) * (h - 14));
      ctx.fillStyle = xEnd >= a && x <= b ? on : "#343946";
      ctx.beginPath();
      ctx.roundRect(x, (h - amp) / 2, Math.max(1.2, bw - 0.6), amp, 1);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(15,17,21,0.55)";
    ctx.fillRect(0, 0, a, h); ctx.fillRect(b, 0, w - b, h);
    for (const x of [a, b]) {
      ctx.fillStyle = "#e8fbf3"; ctx.fillRect(x - 1, 0, 2, h);
      ctx.fillStyle = "#22c55e";
      ctx.beginPath(); ctx.roundRect(x - 5, h / 2 - 12, 10, 24, 4); ctx.fill();
      ctx.fillStyle = "#052e1d"; ctx.fillRect(x - 1.5, h / 2 - 6, 1, 12); ctx.fillRect(x + 0.5, h / 2 - 6, 1, 12);
    }
    if (track.loopOn) {
      const li = xOf(loopInEff()), lo = xOf(loopOutEff());
      ctx.fillStyle = "rgba(245,158,11,0.20)";
      ctx.fillRect(li, 0, Math.max(1, lo - li), 6);
      for (const x of [li, lo]) {
        ctx.fillStyle = "#f59e0b";
        ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 9); ctx.closePath(); ctx.fill();
      }
    }
    if (track.playing && track.pos >= track.viewStart && track.pos <= track.viewEnd) {
      const x = xOf(track.pos);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x - 0.75, 0, 1.5, h);
      ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 6); ctx.closePath(); ctx.fill();
    }
    if (infoEl) {
      const loopInfo = track.loopOn ? ` · Loop ${fmt(loopInEff())}–${fmt(loopOutEff())}` : "";
      const zoomed = viewLen() < track.duration - 0.01;
      const zoomInfo = zoomed ? ` · Zoomed ${fmt(track.viewStart)}–${fmt(track.viewEnd)}` : "";
      infoEl.textContent = `Start ${fmt(track.tin)} · End ${fmt(outTime())} · Length ${fmt(outTime() - track.tin)} / ${fmt(track.duration)}${loopInfo}${zoomInfo}`;
    }
    syncSliders();
  }

  let drag = null;
  const posX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  const posY = (e) => e.clientY - canvas.getBoundingClientRect().top;
  canvas.addEventListener("pointerdown", (e) => {
    if (!track.peaks) return;
    const x = posX(e), y = posY(e);
    if (track.loopOn && y < LOOP_BAND) {
      const dIn = Math.abs(x - xOf(loopInEff())), dOut = Math.abs(x - xOf(loopOutEff()));
      if (Math.min(dIn, dOut) > GRIP) return;
      drag = dIn <= dOut ? "loopIn" : "loopOut";
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const dIn = Math.abs(x - xOf(track.tin)), dOut = Math.abs(x - xOf(outTime()));
    if (Math.min(dIn, dOut) > GRIP) return;
    drag = dIn <= dOut ? "in" : "out";
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => { if (drag) move(posX(e)); });
  canvas.addEventListener("pointerup", () => { if (drag) { drag = null; opts.onCommit(); } });
  canvas.addEventListener("dblclick", () => { track.tin = 0; track.tout = 0; draw(); opts.onCommit(); });

  // zoom/pan: explicit sliders only — no mouse wheel and no drag-to-pan
  const waveEl = canvas.closest(".wave");
  const zoomSlider = waveEl?.querySelector(".wz-zoom");
  const posSlider = waveEl?.querySelector(".wz-pos");
  const fitBtn = waveEl?.querySelector(".wz-fit");
  zoomSlider?.addEventListener("input", () => {
    if (!track.peaks) return;
    zoomTo(widthFromZoomPct(Number(zoomSlider.value)), (track.viewStart + track.viewEnd) / 2);
  });
  posSlider?.addEventListener("input", () => {
    if (!track.peaks) return;
    panTo(startFromPanPct(Number(posSlider.value)));
  });
  fitBtn?.addEventListener("click", () => { if (track.peaks) zoomTo(track.duration, track.duration / 2); });

  function move(x) {
    const t = tOf(x), min = 0.05;
    if (drag === "in") track.tin = Math.min(t, outTime() - min);
    else if (drag === "out") track.tout = Math.max(t, track.tin + min);
    else if (drag === "loopIn") track.lin = Math.max(track.tin, Math.min(t, loopOutEff() - min));
    else if (drag === "loopOut") track.lout = Math.max(loopInEff() + min, Math.min(t, outTime()));
    draw();
  }

  new ResizeObserver(draw).observe(canvas);

  function syncSliders() {
    if (!zoomSlider || !posSlider) return;
    zoomSlider.disabled = !track.peaks;
    zoomSlider.value = track.peaks ? zoomPctFromWidth(viewLen()) : 0;
    const zoomed = viewLen() < track.duration - 0.01;
    posSlider.disabled = !track.peaks || !zoomed;
    posSlider.value = track.peaks ? panPctFromStart(track.viewStart) : 0;
  }
  return {
    draw,
    zoomFit: () => { if (track.peaks) zoomTo(track.duration, track.duration / 2); },
    async setFile(file, fetchWholeFile) {
      track.file = file; track.peaks = null; track.duration = 0; track.zoomPeaks = null;
      track.msg = file ? "Analyzing file…" : "Choose a file";
      this.draw();
      if (!file) return;
      const r = await fetchWholeFile();
      if (track.file !== file) return; // a newer setFile happened meanwhile
      if (!r || r.error) { track.peaks = null; track.msg = (r && r.error) || "Unreadable file"; }
      else { track.peaks = r.peaks; track.duration = r.duration; track.msg = ""; track.viewStart = 0; track.viewEnd = r.duration; }
      this.draw();
    },
  };
}
