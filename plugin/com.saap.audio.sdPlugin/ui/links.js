// Field visibility in the settings panel: an item can be hidden for two independent reasons —
// data-link="cut|fades|volume|loop" (tracks 2-6: hidden when that link is checked, value taken from track 1)
// and data-loopfield="n" (track n: hidden until its own Loop checkbox is checked). The loop-in/out items
// carry both attributes at once, so visibility is recomputed from all flags together on every change,
// rather than each rule blanket-setting style.display independently (which would make them fight).
(() => {
  const { useSettings } = SDPIComponents;
  const linkFlags = { cut: false, fades: false, volume: false, loop: false };
  const loopOn = {}; // track number -> bool

  function applyAll() {
    document.querySelectorAll("sdpi-item[data-link], sdpi-item[data-loopfield]").forEach((el) => {
      const hiddenByLink = el.dataset.link && linkFlags[el.dataset.link];
      const hiddenByLoop = el.dataset.loopfield !== undefined && !loopOn[Number(el.dataset.loopfield)];
      el.style.display = hiddenByLink || hiddenByLoop ? "none" : "";
    });
  }

  // Every sdpi-* element dispatches "valuechange" on itself the instant its own value changes — this is
  // what lets a *different* widget on the same page (here, a plain <sdpi-item>) react immediately. Relying
  // only on useSettings' callback (which fires from a "didReceiveSettings" message coming back over the
  // wire) does not reflect same-page changes made by a sibling widget until the panel is reloaded, e.g. by
  // switching to another key and back.
  function watch(settingName, onChange) {
    document.querySelectorAll(`[setting="${CSS.escape(settingName)}"]`).forEach((el) => {
      el.addEventListener("valuechange", () => onChange(el.value));
    });
  }

  const linkSettings = { cut: "linkCut", fades: "linkFades", volume: "linkVolume", loop: "linkLoop" };
  for (const [kind, setting] of Object.entries(linkSettings)) {
    const apply = (v) => { linkFlags[kind] = !!v; applyAll(); };
    const [get] = useSettings(setting, apply, 0);
    get().then(apply);
    watch(setting, apply);
  }
  for (let n = 1; n <= 6; n++) {
    const loopKey = n === 1 ? "loop" : "loop" + n;
    const apply = (v) => { loopOn[n] = !!v; applyAll(); };
    const [get] = useSettings(loopKey, apply, 0);
    get().then(apply);
    watch(loopKey, apply);
  }

  // shows the file name under the title of each track card
  const baseName = (p) => (p || "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  document.querySelectorAll(".sub[data-file]").forEach((el) => {
    const n = Number(el.dataset.file);
    const show = (v) => { el.textContent = baseName(v) || "No file"; };
    const [get] = useSettings(n === 1 ? "file" : "file" + n, show, 0);
    get().then(show);
  });
})();
