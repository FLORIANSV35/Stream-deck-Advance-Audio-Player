// Sélecteur de sorties multiple : un bouton résumé + un panneau de cases à cocher groupées par périphérique.
(() => {
  const { streamDeckClient: sd, useSettings } = SDPIComponents;
  const DEFAULT = "default::pair::0";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // liste des périphériques, partagée par tous les sélecteurs (une seule demande au plugin)
  let items = null;
  const onItems = [];
  const request = () => sd.send("sendToPlugin", { event: "getOutputs" });
  sd.sendToPropertyInspector.subscribe((ev) => {
    if (ev.payload && ev.payload.event === "getOutputs") { items = ev.payload.items; onItems.forEach((f) => f()); }
  });
  request();

  document.querySelectorAll(".outpick").forEach(init);

  function init(root) {
    const n = Number(root.dataset.n);
    const sfx = (name, extra = "") => (n === 1 ? name : name + extra + n);
    let sel = [DEFAULT];
    const openDevices = new Set();

    const [getOutputs, setOutputs] = useSettings(sfx("outputs"), (v) => { if (Array.isArray(v)) { sel = v; render(); } }, 0);
    // ancien format : une sortie + jusqu'à 3 extras
    const legacy = ["output", "xout1", "xout2", "xout3"].map((k) => useSettings(n === 1 ? k : k + n, null, 0)[0]);
    Promise.all([getOutputs(), ...legacy.map((g) => g())]).then(([out, ...old]) => {
      if (Array.isArray(out)) sel = out;
      else {
        const list = old.filter((v) => typeof v === "string" && v && v !== "none");
        sel = list.length ? [...new Set(list)] : [DEFAULT];
      }
      render();
    });

    root.innerHTML = '<button type="button" class="btn"><span class="txt"></span></button><div class="panel"></div>';
    const btn = root.querySelector(".btn");
    const panel = root.querySelector(".panel");
    onItems.push(render);

    btn.addEventListener("click", () => {
      root.classList.toggle("open");
      if (root.classList.contains("open")) request(); // rafraîchit la liste (interface branchée depuis)
    });
    panel.addEventListener("change", (e) => {
      const box = e.target;
      if (!(box instanceof HTMLInputElement)) return;
      sel = box.checked ? [...sel.filter((v) => v !== box.value), box.value] : sel.filter((v) => v !== box.value);
      setOutputs(sel.slice());
      render();
    });
    panel.addEventListener("toggle", (e) => {
      const d = e.target;
      if (d instanceof HTMLDetailsElement && d.dataset.dev) d.open ? openDevices.add(d.dataset.dev) : openDevices.delete(d.dataset.dev);
    }, true);

    function labels() {
      const map = new Map();
      for (const it of items || []) {
        if (it.children) for (const c of it.children) map.set(c.value, `${it.label} · ${c.label}`);
        else map.set(it.value, it.label);
      }
      return map;
    }

    function render() {
      const names = labels();
      const summary = sel.length ? (names.get(sel[0]) || "Sortie indisponible") : "Sortie par défaut du système";
      btn.querySelector(".txt").textContent = summary;
      btn.querySelector(".more")?.remove();
      if (sel.length > 1) btn.querySelector(".txt").insertAdjacentHTML("afterend", `<span class="more">+${sel.length - 1}</span>`);

      const scroll = panel.scrollTop;
      const opt = (value, label) =>
        `<label class="opt"><input type="checkbox" value="${esc(value)}"${sel.includes(value) ? " checked" : ""}> <span>${esc(label)}</span></label>`;
      let html = "";
      if (!items) html = '<div class="lbl">Recherche des interfaces…</div>';
      else {
        html += opt(DEFAULT, "Sortie par défaut du système");
        for (const it of items.filter((i) => i.children)) {
          const pairs = it.children.filter((c) => c.value.includes("::pair::"));
          const monos = it.children.filter((c) => c.value.includes("::mono::"));
          const count = it.children.filter((c) => sel.includes(c.value)).length;
          html += `<details class="dev" data-dev="${esc(it.label)}"${count || openDevices.has(it.label) ? " open" : ""}>
            <summary>${esc(it.label)}${count ? `<span class="n">${count}</span>` : ""}</summary>
            ${pairs.length ? `<div class="lbl">Stéréo</div><div class="grid">${pairs.map((c) => opt(c.value, c.label.replace("Stéréo ", ""))).join("")}</div>` : ""}
            ${monos.length ? `<div class="lbl">Mono</div><div class="grid mono">${monos.map((c) => opt(c.value, c.label.replace("Mono ", ""))).join("")}</div>` : ""}
          </details>`;
        }
        // sorties cochées mais absentes de la liste (interface débranchée) : on peut les décocher
        const known = new Set([...labels().keys()]);
        const missing = sel.filter((v) => !known.has(v));
        if (missing.length) html += `<div class="lbl">Indisponibles</div>` + missing.map((v) => opt(v, "Sortie absente")).join("");
      }
      panel.innerHTML = html;
      panel.scrollTop = scroll;
    }
    render();
  }
})();
