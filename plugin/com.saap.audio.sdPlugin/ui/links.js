// Field visibility in the settings panel: an item can be hidden for two independent reasons —
// data-link="cut|fades|volume" (tracks 2-6: hidden when that link is checked, value taken from track 1)
// and data-loopfield="n" (track n: hidden until its own Loop checkbox is checked). The loop-in/out items
// carry both attributes at once, so visibility is recomputed from all flags together on every change,
// rather than each rule blanket-setting style.display independently (which would make them fight).
(() => {
  const { useSettings } = SDPIComponents;
  const linkFlags = { cut: false, fades: false, volume: false };
  const loopOn = {}; // track number -> bool

  function applyAll() {
    document.querySelectorAll("sdpi-item[data-link], sdpi-item[data-loopfield]").forEach((el) => {
      const hiddenByLink = el.dataset.link && linkFlags[el.dataset.link];
      const hiddenByLoop = el.dataset.loopfield !== undefined && !loopOn[Number(el.dataset.loopfield)];
      el.style.display = hiddenByLink || hiddenByLoop ? "none" : "";
    });
  }

  const linkSettings = { cut: "linkCut", fades: "linkFades", volume: "linkVolume" };
  for (const [kind, setting] of Object.entries(linkSettings)) {
    const [get] = useSettings(setting, (v) => { linkFlags[kind] = !!v; applyAll(); }, 0);
    get().then((v) => { linkFlags[kind] = !!v; applyAll(); });
  }
  for (let n = 1; n <= 6; n++) {
    const loopKey = n === 1 ? "loop" : "loop" + n;
    const [get] = useSettings(loopKey, (v) => { loopOn[n] = !!v; applyAll(); }, 0);
    get().then((v) => { loopOn[n] = !!v; applyAll(); });
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
