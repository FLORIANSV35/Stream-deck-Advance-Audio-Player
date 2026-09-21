// Masque, sur les pistes 2 à 6, les réglages repris de la piste 1 quand la liaison correspondante est cochée.
(() => {
  const { useSettings } = SDPIComponents;
  const flags = { cut: "linkCut", fades: "linkFades", volume: "linkVolume" };
  for (const [kind, setting] of Object.entries(flags)) {
    const apply = (on) =>
      document.querySelectorAll(`sdpi-item[data-link="${kind}"]`).forEach((el) => { el.style.display = on ? "none" : ""; });
    const [get] = useSettings(setting, (v) => apply(!!v), 0);
    get().then((v) => apply(!!v));
  }

  // affiche le nom du fichier sous le titre de chaque carte de piste
  const baseName = (p) => (p || "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  document.querySelectorAll(".sub[data-file]").forEach((el) => {
    const n = Number(el.dataset.file);
    const show = (v) => { el.textContent = baseName(v) || "Aucun fichier"; };
    const [get] = useSettings(n === 1 ? "file" : "file" + n, show, 0);
    get().then(show);
  });
})();
