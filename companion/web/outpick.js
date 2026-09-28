// Multi-output picker: a summary button + a panel of checkboxes grouped by device. Same interface and behavior
// as the Stream Deck plugin's own outputs.js, adapted to plain callbacks instead of sdpi-components.
const DEFAULT = "default::pair::0";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function createOutputPicker(root, initial, onChange) {
  let items = null;
  let sel = initial && initial.length ? initial : [DEFAULT];
  const openDevices = new Set();

  root.innerHTML = '<button type="button" class="btn"><span class="txt"></span></button><div class="panel"></div>';
  const btn = root.querySelector(".btn");
  const panel = root.querySelector(".panel");

  document.addEventListener("click", (e) => {
    if (root.classList.contains("open") && !root.contains(e.target)) root.classList.remove("open");
  });
  btn.addEventListener("click", () => root.classList.toggle("open"));
  panel.addEventListener("change", (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement)) return;
    sel = box.checked ? [...sel.filter((v) => v !== box.value), box.value] : sel.filter((v) => v !== box.value);
    onChange(sel.slice());
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
    const summary = sel.length ? (names.get(sel[0]) || (sel[0] === DEFAULT ? "System default output" : items ? "Output unavailable" : "…")) : "System default output";
    btn.querySelector(".txt").textContent = summary;
    btn.querySelector(".more")?.remove();
    if (sel.length > 1) btn.querySelector(".txt").insertAdjacentHTML("afterend", `<span class="more">+${sel.length - 1}</span>`);

    const scroll = panel.scrollTop;
    const opt = (value, label) =>
      `<label class="opt"><input type="checkbox" value="${esc(value)}"${sel.includes(value) ? " checked" : ""}> <span>${esc(label)}</span></label>`;
    let html = "";
    if (!items) html = '<div class="lbl">Looking for interfaces…</div>';
    else {
      html += opt(DEFAULT, "System default output");
      for (const it of items.filter((i) => i.children)) {
        const pairs = it.children.filter((c) => c.value.includes("::pair::"));
        const monos = it.children.filter((c) => c.value.includes("::mono::"));
        const count = it.children.filter((c) => sel.includes(c.value)).length;
        html += `<details class="dev" data-dev="${esc(it.label)}"${count || openDevices.has(it.label) ? " open" : ""}>
          <summary>${esc(it.label)}${count ? `<span class="n">${count}</span>` : ""}</summary>
          ${pairs.length ? `<div class="lbl">Stereo</div><div class="grid">${pairs.map((c) => opt(c.value, c.label.replace("Stereo ", ""))).join("")}</div>` : ""}
          ${monos.length ? `<div class="lbl">Mono</div><div class="grid mono">${monos.map((c) => opt(c.value, c.label.replace("Mono ", ""))).join("")}</div>` : ""}
        </details>`;
      }
      const known = new Set([...labels().keys()]);
      const missing = sel.filter((v) => !known.has(v));
      if (missing.length) html += `<div class="lbl">Unavailable</div>` + missing.map((v) => opt(v, "Missing output")).join("");
    }
    panel.innerHTML = html;
    panel.scrollTop = scroll;
  }
  render();

  return {
    setItems(newItems) { items = newItems; render(); },
    setSelected(v) { sel = v && v.length ? v : [DEFAULT]; render(); },
  };
}
