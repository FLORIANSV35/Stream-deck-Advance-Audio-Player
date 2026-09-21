// Hides, on tracks 2 to 6, the settings taken from track 1 when the matching link is checked.
(() => {
  const { useSettings } = SDPIComponents;
  const flags = { cut: "linkCut", fades: "linkFades", volume: "linkVolume" };
  for (const [kind, setting] of Object.entries(flags)) {
    const apply = (on) =>
      document.querySelectorAll(`sdpi-item[data-link="${kind}"]`).forEach((el) => { el.style.display = on ? "none" : ""; });
    const [get] = useSettings(setting, (v) => apply(!!v), 0);
    get().then((v) => apply(!!v));
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
