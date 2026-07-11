export function createLiveAnnouncer(region) {
  let previous = "";
  return {
    announce(message) {
      const next = String(message ?? "").trim();
      if (!next || next === previous) return;
      previous = next;
      region.textContent = "";
      queueMicrotask(() => { region.textContent = next; });
    },
  };
}
