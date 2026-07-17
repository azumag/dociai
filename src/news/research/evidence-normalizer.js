// EvidenceNormalizer (issue #190): providerごとに形の違う生データを、EvidenceFact/Source
// 共通契約へそろえる。opinion/forecastをfactへ変換しない — kindは呼び出し側 (provider) が
// 明示し、ここでは形式だけを正す。

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_KIND = new Set(["fact", "background", "viewpoint", "forecast"]);

export function normalizeEvidenceFact(raw, { kind = "fact", defaultConfidence = "medium" } = {}) {
  const text = String(raw?.text ?? "").trim();
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
