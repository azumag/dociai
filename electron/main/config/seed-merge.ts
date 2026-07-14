export type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

// personasのbackfill (missingPersonas) で復活したペルソナが参照するtrigger IDのうち、
// 現在のtriggersに無いものだけをlegacy configから補完する。isFreshInstallでない限り
// triggers全体は上書きしない (#405: ユーザーが設定UIで全トリガーを意図的に削除した状態を
// 保つため) が、それだと「personasだけ古い参照ごと復活し、参照先のtriggerは無い」という
// 不整合が起きる。参照されているIDに限定した補完でこれを防ぐ。
export function backfillReferencedTriggers(currentTriggers: unknown, backfilledPersonas: unknown, legacyTriggers: unknown): JsonRecord | null {
  const current = object(currentTriggers);
  const legacy = object(legacyTriggers);
  const referenced = new Set<string>();
  for (const persona of Array.isArray(backfilledPersonas) ? backfilledPersonas : []) {
    const triggers = (persona as JsonRecord | undefined)?.triggers;
    for (const tid of Array.isArray(triggers) ? triggers : []) {
      if (typeof tid === "string" && tid !== "manual") referenced.add(tid);
    }
  }
  const missing: JsonRecord = {};
  for (const tid of referenced) {
    if (!current[tid] && legacy[tid]) missing[tid] = legacy[tid];
  }
  return Object.keys(missing).length ? { ...current, ...missing } : null;
}
