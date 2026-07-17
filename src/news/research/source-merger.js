// SourceMerger (issue #190)
// 複数providerの結果をcanonical URL/host/title類似度で統合し、NewsResearchBundleへまとめる。
// 同一publisherの転載は独立source数へ数えない。1 sourceのみの主張はconfidenceを上げすぎず、
// 対立する数値はunresolvedへ残す (どちらかを勝手に消さない)。

import { computeUrlHash } from "../selection/normalize-news-key.js";
import { normalizeEvidenceFact, normalizeSourceCitation } from "./evidence-normalizer.js";

function canonicalHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function extractNumbers(text) {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => match[0]);
}

// ひらがな/カタカナ/漢字/英字の連続をtokenとみなす軽量heuristic (形態素解析はしない)。
function significantTokens(text) {
  return [...text.matchAll(/[A-Za-z]+|[一-鿿぀-ヿ]+/g)].map((match) => match[0]).filter((t) => t.length >= 2);
}

// 話題が重なる (token 2件以上共有) のに数値が食い違う2 factを対立claimとして検出する。
function detectConflicts(facts) {
  const conflicts = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i];
      const b = facts[j];
      const aTokens = new Set(significantTokens(a.text));
      const bTokens = significantTokens(b.text);
      const shared = bTokens.filter((token) => aTokens.has(token));
      if (shared.length < 2) continue;
      const aNumbers = extractNumbers(a.text);
      const bNumbers = extractNumbers(b.text);
      if (!aNumbers.length || !bNumbers.length) continue;
      const differs = aNumbers.some((n) => !bNumbers.includes(n)) || bNumbers.some((n) => !aNumbers.includes(n));
      if (differs) conflicts.push(`「${a.text}」と「${b.text}」で数値が食い違っています`);
    }
  }
  return conflicts;
}

function dedupeFacts(facts) {
  const byText = new Map();
  for (const fact of facts) {
    if (!fact.text) continue;
    const key = fact.text.trim();
    const existing = byText.get(key);
    if (!existing) {
      byText.set(key, { ...fact, sourceIds: [...fact.sourceIds] });
      continue;
    }
    for (const id of fact.sourceIds) if (!existing.sourceIds.includes(id)) existing.sourceIds.push(id);
    // 独立した複数sourceが同じ事実を裏付けた場合はconfidenceを一段引き上げる (1 sourceだけの
    // 主張のconfidenceを上げすぎない、の裏返し)。
    if (existing.sourceIds.length >= 2 && existing.confidence !== "high") existing.confidence = "high";
  }
  return [...byText.values()];
}

function dedupeStrings(values) {
  return [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
}

export function mergeProviderResults(candidateId, headline, providerResults) {
  const sourcesByHash = new Map(); // hash -> { id, ...citation }
  const idByHash = new Map();
  let sequence = 0;

  const resolveSourceId = (url, sourceName, extra = {}) => {
    if (!url) return null;
    const hash = computeUrlHash(url) ?? url;
    if (!idByHash.has(hash)) {
      sequence += 1;
      const id = `s${sequence}`;
      idByHash.set(hash, id);
      sourcesByHash.set(hash, { id, ...normalizeSourceCitation({ url, sourceName, ...extra }) });
    }
    return idByHash.get(hash);
  };

  for (const result of providerResults) {
    for (const source of result.sources ?? []) resolveSourceId(source.url, source.sourceName, source);
  }

  const factsByKind = { fact: [], background: [], viewpoint: [] };
  for (const result of providerResults) {
    for (const rawFact of result.facts ?? []) {
      const normalized = normalizeEvidenceFact(rawFact);
      const sourceId = normalized.sourceUrl ? resolveSourceId(normalized.sourceUrl, normalized.sourceName) : null;
      const bucket = normalized.kind === "background" ? "background" : normalized.kind === "viewpoint" || normalized.kind === "forecast" ? "viewpoint" : "fact";
      factsByKind[bucket].push({ text: normalized.text, sourceIds: sourceId ? [sourceId] : [], confidence: normalized.confidence, kind: normalized.kind });
    }
  }

  const facts = dedupeFacts(factsByKind.fact).filter((f) => f.text);
  const background = dedupeStrings(factsByKind.background.map((f) => f.text));
  const viewpoints = dedupeStrings(factsByKind.viewpoint.map((f) => f.text));
  const unresolved = new Set();
  for (const result of providerResults) for (const entry of result.unresolved ?? []) if (entry) unresolved.add(String(entry));
  for (const conflict of detectConflicts(facts)) unresolved.add(conflict);

  const sources = [...sourcesByHash.values()];
  const independentHosts = new Set(sources.map((s) => canonicalHost(s.url)).filter(Boolean));

  return {
    candidateId,
    headline,
    facts,
    background,
    viewpoints,
    unresolved: [...unresolved],
    sources,
    coverage: {
      sourceCount: sources.length,
      independentPublisherCount: independentHosts.size,
      hasPrimarySource: sources.some((s) => s.isPrimary),
      hasConflictingClaims: unresolved.size > 0,
    },
  };
}
