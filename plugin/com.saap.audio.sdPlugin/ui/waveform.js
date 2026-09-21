// Waveform with trim handles (trim in / trim out) for each track.
(() => {
  const { streamDeckClient: sd, useSettings } = SDPIComponents;
  const key = (name, n) => (n === 1 ? name : name + n);
  const num = (v) => parseFloat(String(v ?? "").replace(",", ".")) || 0;
  const fmt = (s) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
  };
  const GRIP = 12; // grab zone of a handle, in px

  document.querySelectorAll(".wave").forEach(init);

  function init(root) {
    const n = Number(root.dataset.n);
    root.innerHTML = '<canvas></canvas><div class="wave-info"></div>';
    const canvas = root.querySelector("canvas");
    const info = root.querySelector(".wave-info");
    const ctx = canvas.getContext("2d");
    // Slave track with linked trim: the trim shown is track 1's, not editable here.
    const st = {
      file: "", duration: 0, peaks: null, msg: "Choose a file",
      ownIn: 0, ownOut: 0, mIn: 0, mOut: 0, linked: false,
      get tin() { return this.linked ? this.mIn : this.ownIn; }, set tin(v) { this.ownIn = v; },
      get tout() { return this.linked ? this.mOut : this.ownOut; }, set tout(v) { this.ownOut = v; },
    };

    // no debounce: settings are saved when the handle is released
    const [getFile] = useSettings(key("file", n), (v) => setFile(v), 0);
    const [getIn, setIn] = useSettings(key("trimIn", n), (v) => { st.ownIn = num(v); draw(); }, 0);
    const [getOut, setOut] = useSettings(key("trimOut", n), (v) => { st.ownOut = num(v); draw(); }, 0);
    Promise.all([getFile(), getIn(), getOut()]).then(([f, i, o]) => { st.ownIn = num(i); st.ownOut = num(o); setFile(f); });
    if (n > 1) {
      const [gLink] = useSettings("linkCut", (v) => { st.linked = !!v; draw(); }, 0);
      const [gMIn] = useSettings("trimIn", (v) => { st.mIn = num(v); draw(); }, 0);
      const [gMOut] = useSettings("trimOut", (v) => { st.mOut = num(v); draw(); }, 0);
      Promise.all([gLink(), gMIn(), gMOut()]).then(([l, i, o]) => { st.linked = !!l; st.mIn = num(i); st.mOut = num(o); draw(); });
    }

    sd.sendToPropertyInspector.subscribe((ev) => {
      const p = ev.payload;
      if (!p || p.event !== "peaks" || p.track !== n || p.file !== st.file) return;
      if (p.error) { st.peaks = null; st.msg = p.error; }
      else { st.peaks = p.peaks; st.duration = p.duration; st.msg = ""; }
      draw();
    });

    function setFile(f) {
      f = f || "";
      if (f === st.file && (st.peaks || !f)) return;
      st.file = f; st.peaks = null; st.duration = 0;
      st.msg = f ? "Analyzing file…" : "Choose a file";
      if (f) sd.send("sendToPlugin", { event: "getPeaks", file: f, track: n });
      draw();
    }

    const outTime = () => (st.tout > 0 && st.tout < st.duration ? st.tout : st.duration);
    const xOf = (t) => (t / st.duration) * canvas.clientWidth;
    const tOf = (x) => Math.max(0, Math.min(st.duration, (x / canvas.clientWidth) * st.duration));

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w) return; // collapsed section
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!st.peaks) {
        ctx.fillStyle = "#6b7383"; ctx.font = "12px -apple-system, sans-serif"; ctx.textAlign = "center";
        ctx.fillText(st.msg, w / 2, h / 2 + 4);
        info.textContent = "";
        return;
      }
      const a = xOf(Math.min(st.tin, st.duration)), b = xOf(outTime());
      const bw = w / st.peaks.length;
      const on = ctx.createLinearGradient(0, 0, 0, h);
      on.addColorStop(0, "#5eead4"); on.addColorStop(1, "#22c55e");
      for (let i = 0; i < st.peaks.length; i++) {
        const x = i * bw, amp = Math.max(2, Math.pow(st.peaks[i], 0.8) * (h - 14));
        ctx.fillStyle = x + bw >= a && x <= b ? on : "#343946";
        ctx.beginPath();
        ctx.roundRect(x, (h - amp) / 2, Math.max(1.2, bw - 0.6), amp, 1);
        ctx.fill();
      }
      // trimmed zones: dark veil; handles: line + rounded grip
      ctx.fillStyle = "rgba(15,17,21,0.55)";
      ctx.fillRect(0, 0, a, h); ctx.fillRect(b, 0, w - b, h);
      for (const x of [a, b]) {
        ctx.fillStyle = "#e8fbf3"; ctx.fillRect(x - 1, 0, 2, h);
        ctx.fillStyle = "#22c55e";
        ctx.beginPath(); ctx.roundRect(x - 5, h / 2 - 12, 10, 24, 4); ctx.fill();
        ctx.fillStyle = "#052e1d"; ctx.fillRect(x - 1.5, h / 2 - 6, 1, 12); ctx.fillRect(x + 0.5, h / 2 - 6, 1, 12);
      }
      info.textContent = (st.linked ? "Linked to track 1 · " : "") + `Start ${fmt(st.tin)} · End ${fmt(outTime())} · Length ${fmt(outTime() - st.tin)} / ${fmt(st.duration)}`;
    }

    let drag = null;
    const posX = (e) => e.clientX - canvas.getBoundingClientRect().left;
    canvas.addEventListener("pointerdown", (e) => {
      if (!st.peaks || st.linked) return;
      const x = posX(e);
      const dIn = Math.abs(x - xOf(st.tin)), dOut = Math.abs(x - xOf(outTime()));
      drag = dIn <= dOut ? "in" : "out";
      if (Math.min(dIn, dOut) > GRIP) move(x); // click away from a handle: moves the nearest one
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => { if (drag) move(posX(e)); });
    canvas.addEventListener("pointerup", () => { if (drag) { drag = null; commit(); } });
    canvas.addEventListener("dblclick", () => {
      if (st.linked) return; st.tin = 0; st.tout = 0; draw(); commit(); }); // double-click: whole file

    function move(x) {
      const t = tOf(x), min = 0.05;
      if (drag === "in") st.tin = Math.min(t, outTime() - min);
      else st.tout = Math.max(t, st.tin + min);
      draw();
    }

    function commit() {
      const inV = st.tin < 0.01 ? "" : st.tin.toFixed(2);
      const outV = !st.tout || st.tout > st.duration - 0.01 ? "" : st.tout.toFixed(2);
      if (!outV) st.tout = 0;
      setIn(inV); setOut(outV);
      // also updates the text fields shown in the panel
      for (const [name, v] of [["trimIn", inV], ["trimOut", outV]]) {
        const el = document.querySelector(`sdpi-textfield[setting="${key(name, n)}"]`);
        if (el) el.value = v;
      }
    }

    window.addEventListener("resize", draw);
    root.closest("details")?.addEventListener("toggle", draw);
    draw();
  }
})();
