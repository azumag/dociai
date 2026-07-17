// NewsSchedulePolicy (issue #193): 時刻slot起動の判定。TriggerEngineへの実配線は行わない
// (config設計・feature flag/rollout判断は#194、TriggerEngineは現状setInterval/hotkeyしか
// 知らず時刻slot概念自体が無い) — 呼び出し側がwall clockを定期pollし、resolveDueSlot()の
// 結果に従ってpipelineを起動する想定の純粋関数として先に用意する。
//
// setIntervalだけでは sleep/wake 中に見逃したslotをまとめて発火 (catch-up storm) したり、
// 同一分内の複数poll で同一slotを二重発火したりする。ここではslot key (id+日付) の既知集合
// (firedSlotKeys) との突き合わせで二重発火を防ぎ、tolerance windowの外は「見逃し」として
// 諦める (まとめてcatch-upしない) ことで両方を避ける。

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function buildSlotKey(slot, now) {
  return `${slot.id}:${localDateKey(now)}`;
}

function isSlotDueNow(slot, now, defaultToleranceMinutes) {
  if (Array.isArray(slot.daysOfWeek) && slot.daysOfWeek.length && !slot.daysOfWeek.includes(now.getDay())) return false;
  const diff = minutesSinceMidnight(now) - Number(slot.minute);
  const tolerance = slot.toleranceMinutes ?? defaultToleranceMinutes;
  return diff >= 0 && diff <= tolerance;
}

// 複数slotが同時に条件を満たす場合はslots配列の先頭を優先する (呼び出し側がslotsを
// 並べる順番で優先度を決める)。
export function resolveDueSlot({ slots = [], now = new Date(), firedSlotKeys = new Set(), lastFiredAt = null, cooldownMinutes = 0, maxRunsPerHour = null, runsInLastHour = 0, defaultToleranceMinutes = 5 }) {
  if (cooldownMinutes > 0 && lastFiredAt != null && now.getTime() - lastFiredAt < cooldownMinutes * 60_000) return null;
  if (maxRunsPerHour != null && runsInLastHour >= maxRunsPerHour) return null;
  for (const slot of slots) {
    if (!isSlotDueNow(slot, now, defaultToleranceMinutes)) continue;
    const slotKey = buildSlotKey(slot, now);
    if (firedSlotKeys.has(slotKey)) continue;
    return { slot, slotKey };
  }
  return null;
}

export function jitterDelayMs(jitterSeconds = 0, rng = Math.random) {
  if (!jitterSeconds) return 0;
  return Math.floor(rng() * jitterSeconds * 1000);
}
