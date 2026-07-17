// EvidenceNormalizer (issue #190): providerごとに形の違う生データを、EvidenceFact/Source
// 共通契約へそろえる。opinion/forecastをfactへ変換しない — kindは呼び出し側 (provider) が
// 明示し、ここでは形式だけを正す。

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_KIND = new Set(["fact", "background", "viewpoint", "forecast"]);

export function normalizeEvidenceFact(raw, { kind = "fact", defaultConfidence = "medium" } = {}) {
  // NFKC正規化: 全角数字("１２人")と半角数字("12人")を同一視できるようにする。source-merger.js
  // のdetectConflicts/dedupeFactsは正規化後のtextで数値抽出・完全一致判定を行うため、ここで
  // そろえないと全角/半角の違いだけで対立検出・重複統合の両方が漏れる。
  const text = String(raw?.text ?? "").normalize("NFKC").trim();
  const confidence = VALID_CONFIDENCE.has(raw?.confidence) ? raw.confidence : defaultConfidence;
  const resolvedKind = VALID_KIND.has(raw?.kind) ? raw.kind : kind;
  return {
    text,
    sourceUrl: raw?.sourceUrl ?? null,
    sourceName: raw?.sourceName ?? null,
    confidence,
    kind: resolvedKind,
  };
}

export function normalizeSourceCitation(raw) {
  return {
    url: raw?.url ?? null,
    sourceName: raw?.sourceName ?? "",
    publishedAt: raw?.publishedAt ?? null,
    license: raw?.license ?? null,
    isPrimary: raw?.isPrimary === true,
  };
}
