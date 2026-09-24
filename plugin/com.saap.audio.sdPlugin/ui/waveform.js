// Waveform with trim handles (trim in / trim out), and loop-in/loop-out markers when Loop is enabled, for each track.
(() => {
  const { streamDeckClient: sd, useSettings } = SDPIComponents;
  const key = (name, n) => (n === 1 ? name : name + n);
  const num = (v) => parseFloat(String(v ?? "").replace(",", ".")) || 0;
  const fmt = (s) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
  };
  const GRIP = 12; // grab zone of a handle, in px

  // Every sdpi-* element dispatches "valuechange" on itself the instant its own value changes — this is
  // what lets a *different* widget on the same page (here, the waveform canvas) react immediately to, say,
  // track 1's trim field or another track's Loop checkbox. Relying only on useSettings' callback (which
  // fires from a "didReceiveSettings" message coming back over the wire) does not reflect same-page
  // changes made by a sibling widget until the panel is reloaded, e.g. by switching to another key and back.
  function watch(settingName, onChange) {
    document.querySelectorAll(`[setting="${CSS.escape(settingName)}"]`).forEach((el) => {
      el.addEventListener("valuechange", () => onChange(el.value));
    });
  }

  document.querySelectorAll(".wave").forEach(init);

  function init(root) {
    const n = Number(root.dataset.n);
    root.innerHTML = '<canvas></canvas><div class="wave-info"></div>';
    const canvas = root.querySelector("canvas");
    const info = root.querySelector(".wave-info");
    const ctx = canvas.getContext("2d");
    // Slave track: trim and loop points can each be linked to track 1 independently.
    const st = {
      file: "", duration: 0, peaks: null, msg: "Choose a file",
      ownIn: 0, ownOut: 0, mIn: 0, mOut: 0, trimLinked: false,
      get tin() { return this.trimLinked ? this.mIn : this.ownIn; }, set tin(v) { this.ownIn = v; },
      get tout() { return this.trimLinked ? this.mOut : this.ownOut; }, set tout(v) { this.ownOut = v; },
      // loop enable is always this track's own (never linked); only the loop points can follow track 1
      loopOn: false, ownLoopIn: 0, ownLoopOut: 0, mLoopIn: 0, mLoopOut: 0, loopLinked: false,
      get lin() { return this.loopLinked ? this.mLoopIn : this.ownLoopIn; }, set lin(v) { this.ownLoopIn = v; },
      get lout() { return this.loopLinked ? this.mLoopOut : this.ownLoopOut; }, set lout(v) { this.ownLoopOut = v; },
    };

    // no debounce: settings are saved when the handle is released
    const [getFile] = useSettings(key("file", n), (v) => setFile(v), 0);
    const onIn = (v) => { st.ownIn = num(v); draw(); };
    const onOut = (v) => { st.ownOut = num(v); draw(); };
    const onLoopOn = (v) => { st.loopOn = !!v; draw(); };
    const onLoopIn = (v) => { st.ownLoopIn = num(v); draw(); };
    const onLoopOut = (v) => { st.ownLoopOut = num(v); draw(); };
    const [getIn, setIn] = useSettings(key("trimIn", n), onIn, 0);
    const [getOut, setOut] = useSettings(key("trimOut", n), onOut, 0);
    const [getLoopOn] = useSettings(key("loop", n), onLoopOn, 0);
    const [getLoopIn, setLoopIn] = useSettings(key("loopIn", n), onLoopIn, 0);
    const [getLoopOut, setLoopOut] = useSettings(key("loopOut", n), onLoopOut, 0);
    Promise.all([getFile(), getIn(), getOut(), getLoopOn(), getLoopIn(), getLoopOut()]).then(([f, i, o, lon, li, lo]) => {
      st.ownIn = num(i); st.ownOut = num(o); st.loopOn = !!lon; st.ownLoopIn = num(li); st.ownLoopOut = num(lo);
      setFile(f);
    });
    watch(key("file", n), setFile);
    watch(key("trimIn", n), onIn);
    watch(key("trimOut", n), onOut);
    watch(key("loop", n), onLoopOn);
    watch(key("loopIn", n), onLoopIn);
    watch(key("loopOut", n), onLoopOut);

    if (n > 1) {
      const onTrimLink = (v) => { st.trimLinked = !!v; draw(); };
      const onLoopLink = (v) => { st.loopLinked = !!v; draw(); };
      const onMIn = (v) => { st.mIn = num(v); draw(); };
      const onMOut = (v) => { st.mOut = num(v); draw(); };
      const onMLoopIn = (v) => { st.mLoopIn = num(v); draw(); };
      const onMLoopOut = (v) => { st.mLoopOut = num(v); draw(); };
      const [gTrimLink] = useSettings("linkCut", onTrimLink, 0);
      const [gLoopLink] = useSettings("linkLoop", onLoopLink, 0);
      const [gMIn] = useSettings("trimIn", onMIn, 0);
      const [gMOut] = useSettings("trimOut", onMOut, 0);
      const [gMLoopIn] = useSettings("loopIn", onMLoopIn, 0);
      const [gMLoopOut] = useSettings("loopOut", onMLoopOut, 0);
      Promise.all([gTrimLink(), gLoopLink(), gMIn(), gMOut(), gMLoopIn(), gMLoopOut()]).then(([tl, ll, i, o, li, lo]) => {
        st.trimLinked = !!tl; st.loopLinked = !!ll; st.mIn = num(i); st.mOut = num(o); st.mLoopIn = num(li); st.mLoopOut = num(lo);
        draw();
      });
      watch("linkCut", onTrimLink);
      watch("linkLoop", onLoopLink);
      watch("trimIn", onMIn);
      watch("trimOut", onMOut);
      watch("loopIn", onMLoopIn);
      watch("loopOut", onMLoopOut);
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
      clearInterval(peaksRetry);
      if (f) {
        const ask = () => sd.send("sendToPlugin", { event: "getPeaks", file: f, track: n });
        ask();
        // if the plugin was not ready to answer (first open of the panel), ask again until the waveform arrives
        let attempts = 0;
        peaksRetry = setInterval(() => { if (st.peaks || st.file !== f || ++attempts > 5) clearInterval(peaksRetry); else ask(); }, 4000);
      }
      draw();
    }
    let peaksRetry;

    const outTime = () => (st.tout > 0 && st.tout < st.duration ? st.tout : st.duration);
    // loop-out follows the same "0 = end" convention as trim-out, but clamped to the trim range
    const loopOutEff = () => (st.lout > 0 && st.lout < outTime() ? st.lout : outTime());
    const loopInEff = () => Math.max(st.tin, Math.min(st.lin, loopOutEff()));
    const xOf = (t) => (t / st.duration) * canvas.clientWidth;
    const tOf = (x) => Math.max(0, Math.min(st.duration, (x / canvas.clientWidth) * st.duration));
    const LOOP_BAND = 16; // px from the top reserved for loop-marker hit-testing, clear of the trim grips

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
      // loop markers: small amber flags along the top edge, distinct from the trim handles' grips lower down
      if (st.loopOn) {
        const li = xOf(loopInEff()), lo = xOf(loopOutEff());
        ctx.fillStyle = "rgba(245,158,11,0.20)";
        ctx.fillRect(li, 0, Math.max(1, lo - li), 6);
        for (const x of [li, lo]) {
          ctx.fillStyle = "#f59e0b";
          ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 9); ctx.closePath(); ctx.fill();
        }
      }
      const linkedBits = [st.trimLinked && "trim", st.loopLinked && "loop"].filter(Boolean);
      const linkedInfo = linkedBits.length ? `${linkedBits.join(" & ")} linked to track 1 · ` : "";
      const loopInfo = st.loopOn ? ` · Loop ${fmt(loopInEff())}–${fmt(loopOutEff())}` : "";
      info.textContent = linkedInfo + `Start ${fmt(st.tin)} · End ${fmt(outTime())} · Length ${fmt(outTime() - st.tin)} / ${fmt(st.duration)}${loopInfo}`;
    }

    let drag = null;
    const posX = (e) => e.clientX - canvas.getBoundingClientRect().left;
    const posY = (e) => e.clientY - canvas.getBoundingClientRect().top;
    canvas.addEventListener("pointerdown", (e) => {
      if (!st.peaks) return;
      const x = posX(e), y = posY(e);
      if (st.loopOn && y < LOOP_BAND) {
        if (st.loopLinked) return; // read-only: loop points come from track 1 here
        const dIn = Math.abs(x - xOf(loopInEff())), dOut = Math.abs(x - xOf(loopOutEff()));
        drag = dIn <= dOut ? "loopIn" : "loopOut";
        if (Math.min(dIn, dOut) > GRIP) move(x); // click away from a handle: moves the nearest one
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (st.trimLinked) return; // read-only: trim comes from track 1 here
      const dIn = Math.abs(x - xOf(st.tin)), dOut = Math.abs(x - xOf(outTime()));
      drag = dIn <= dOut ? "in" : "out";
      if (Math.min(dIn, dOut) > GRIP) move(x);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => { if (drag) move(posX(e)); });
    canvas.addEventListener("pointerup", () => { if (drag) { drag = null; commit(); } });
    canvas.addEventListener("dblclick", () => {
      if (st.trimLinked) return; st.tin = 0; st.tout = 0; draw(); commit(); }); // double-click: whole file

    function move(x) {
      const t = tOf(x), min = 0.05;
      if (drag === "in") st.tin = Math.min(t, outTime() - min);
      else if (drag === "out") st.tout = Math.max(t, st.tin + min);
      else if (drag === "loopIn") st.lin = Math.max(st.tin, Math.min(t, loopOutEff() - min));
      else if (drag === "loopOut") st.lout = Math.max(loopInEff() + min, Math.min(t, outTime()));
      draw();
    }

    function setField(name, v) {
      const el = document.querySelector(`sdpi-textfield[setting="${key(name, n)}"]`);
      if (el) el.value = v;
    }

    function commit() {
      // only save what this track actually owns: re-saving a linked (read-only) value back into this
      // track's own hidden setting would silently overwrite it with track 1's current value
      if (!st.trimLinked) {
        const inV = st.tin < 0.01 ? "" : st.tin.toFixed(2);
        const outV = !st.tout || st.tout > st.duration - 0.01 ? "" : st.tout.toFixed(2);
        if (!outV) st.tout = 0;
        setIn(inV); setOut(outV);
        setField("trimIn", inV); setField("trimOut", outV);
      }
      if (!st.loopLinked) {
        const loopInV = st.lin < 0.01 ? "" : st.lin.toFixed(2);
        const loopOutV = !st.lout || st.lout > st.duration - 0.01 ? "" : st.lout.toFixed(2);
        if (!loopOutV) st.lout = 0;
        setLoopIn(loopInV); setLoopOut(loopOutV);
        setField("loopIn", loopInV); setField("loopOut", loopOutV);
      }
    }

    window.addEventListener("resize", draw);
    root.closest("details")?.addEventListener("toggle", draw);
    // canvas.clientWidth can still be 0 the first time draw() runs (the property inspector's webview
    // hasn't finished laying out the page yet, e.g. right after the panel opens or peaks arrive very
    // fast) — draw() silently no-ops on a zero width, so without this the waveform stays blank until
    // something else forces a layout pass (switching keys and back). A ResizeObserver re-fires the
    // moment the canvas actually gets a real size, on any platform/webview.
    new ResizeObserver(draw).observe(canvas);
    draw();
  }
})();
