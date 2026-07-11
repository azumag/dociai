const NEXT_KEYS = new Set(["ArrowDown", "ArrowRight"]);
const PREVIOUS_KEYS = new Set(["ArrowUp", "ArrowLeft"]);

// WAI-ARIA tabs の roving tabindex と矢印移動だけを担当する。
// パネル描画や state 所有は SettingsUI 側に残すため、DOM なしで単体検証できる。
export function createTabsController({ tabs, activate, orientation = () => "vertical" }) {
  const move = (from, direction) => {
    const buttons = [...tabs()];
    if (!buttons.length) return;
    const index = Math.max(0, buttons.indexOf(from));
    const next = buttons[(index + direction + buttons.length) % buttons.length];
    activate(next.dataset.tab, { focus: true, announce: true });
  };

  return {
    onKeydown(event) {
      const key = event.key;
      const horizontal = orientation() === "horizontal";
      const next = horizontal ? key === "ArrowRight" : key === "ArrowDown";
      const previous = horizontal ? key === "ArrowLeft" : key === "ArrowUp";
      if (next || NEXT_KEYS.has(key) && horizontal) { event.preventDefault(); move(event.currentTarget, 1); return; }
      if (previous || PREVIOUS_KEYS.has(key) && horizontal) { event.preventDefault(); move(event.currentTarget, -1); return; }
      if (key === "Home") { event.preventDefault(); tabs()[0]?.dataset.tab && activate(tabs()[0].dataset.tab, { focus: true, announce: true }); }
      if (key === "End") { event.preventDefault(); const buttons = tabs(); const last = buttons.at(-1); if (last) activate(last.dataset.tab, { focus: true, announce: true }); }
    },
  };
}
