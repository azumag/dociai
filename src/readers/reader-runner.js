export function createReaderItemKey(item, readerKind) {
  const source = String(item.sourceName ?? "").slice(0, 128);
  // guid/link/title は外部入力なので、保存用 key に本文を残さず安定 hash 化する。
  const identity = item.guid || item.link || `${item.normalizedTitle ?? item.title ?? ""}|${item.publishedAt ?? ""}`;
  return `${readerKind}:${hash(`${source}|${identity}`)}`;
}

export function retryOptions(config = {}) {
  const retry = config.retry ?? {};
  return {
    maxAttempts: positiveInteger(retry.maxAttempts, 3),
    initialDelayMs: positiveInteger(retry.initialDelaySeconds, 30) * 1000,
    maxDelayMs: positiveInteger(retry.maxDelaySeconds, 15 * 60) * 1000,
  };
}

export function readerStatus(store, enabled, busy, lastRunAt) {
  const counts = store.counts();
  const retryItems = store.list({ states: "retry_wait" });
  const nextRetryAt = retryItems.length ? Math.min(...retryItems.map((item) => item.nextRetryAt).filter(Number.isFinite)) : null;
  return {
    enabled,
    busy,
    readCount: counts.read,
    counts,
    nextRetryAt: Number.isFinite(nextRetryAt) ? nextRetryAt : null,
    failures: store.list({ states: ["retry_wait", "failed_permanent"], limit: 5 }),
    lastRunAt,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function hash(value) {
  let left = 0x811c9dc5;
  let right = 0x01000193;
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + 0x9e3779b9), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}
