export type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

// personasが参照するtrigger IDのうち、現在のtriggersに無いものだけをlegacy configから
// 補完する。isFreshInstallでない限りtriggers全体は上書きしない (#405: ユーザーが設定UIで
// 全トリガーを意図的に削除した状態を保つため) が、それだと「personasは古い参照ごと存在し、
// 参照先のtriggerは無い」という不整合が起きる。この不整合はbackfill (missingPersonas) で
// 復活した直後のpersonasだけでなく、trigger補完なしでpersonasをbackfillしていた旧バージョンが
// config.jsonへ保存してしまったpersonasにも残っているため、呼び出し側は保存済みpersonasも
// 渡して毎起動で修復する。参照されているIDに限定した補完なので、参照が無いtriggerを
// 復活させることはない。
export function backfillReferencedTriggers(currentTriggers: unknown, personas: unknown, legacyTriggers: unknown): JsonRecord | null {
  const current = object(currentTriggers);
  const legacy = object(legacyTriggers);
  const referenced = new Set<string>();
  for (const persona of Array.isArray(personas) ? personas : []) {
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
