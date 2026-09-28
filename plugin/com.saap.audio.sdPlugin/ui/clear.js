// "Clear" button next to a track's File field: removes that track's file and its trim/loop points (its
// output, volume and fades are left alone — those are the track's own routing/level, not tied to which file
// happens to be loaded on it).
(() => {
  const FIELDS = ["trimIn", "trimOut", "loopIn", "loopOut", "loopFade"];
  document.querySelectorAll("button.clear-file").forEach((btn) => {
    const n = btn.dataset.n;
    const key = (name) => (n === "1" ? name : name + n);
    const set = (name, value) => {
      const el = document.querySelector(`[setting="${CSS.escape(key(name))}"]`);
      if (el) el.value = value;
    };
    btn.addEventListener("click", () => {
      set("file", "");
      set("loop", false);
      for (const f of FIELDS) set(f, "");
    });
  });
})();
