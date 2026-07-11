export function deferFocus(element) {
  if (!element) return;
  requestAnimationFrame(() => element.focus({ preventScroll: true }));
}

export function restoreFocus(element) {
  if (element?.isConnected && !element.disabled) deferFocus(element);
}
