// selection policy (issue #189):
//   score = freshnessWeight * sourceDiversityWeight * contentQualityWeight
//         * modeRelevanceWeight * manualPriorityWeight
// 既定はweighted random。maxItems複数時は同一topic/sourceの連続選択を避ける
// (代替候補が尽きたら制約を緩める)。

import { sourceDiversityWeight } from "./source-diversity.js";

const CONTENT_QUALITY_WEIGHTS = Object.freeze({ article: 1, "feed-content": 0.85, "feed-summary": 0.6, headline: 0.35 });

function contentOriginOf(item) {
  if (item.contentOrigin) return item.contentOrigin;
  if (item.content) return "feed-content";
  if (String(item.description ?? item.summary ?? "").trim().length > 0) return "feed-summary";
  return "headline";
}

// publishedAtが実時計(now)より未来ならnowへclampしwarningを積む。newestTimestampは
// このclamp後の値から求めるため、「一番新しい候補自身が未来日時」でもclampが効く。
function resolvePublishedAt(item, now, warnings) {
  const t = Date.parse(item.publishedAt ?? "");
  if (!Number.isFinite(t)) return null;
  if (t > now) {
    warnings.push(`future publishedAt clamped: ${item.processingKey ?? item.guid ?? item.title}`);
    return now;
  }
  return t;
}

// publishedAt不明は固定0.25。
function freshnessWeight(effectiveTimestamp, newestTimestamp, halfLifeHours) {
  if (effectiveTimestamp == null) return 0.25;
  const ageMs = Math.max(0, newestTimestamp - effectiveTimestamp);
  const halfLifeMs = Math.max(1, halfLifeHours) * 60 * 60 * 1000;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

export function createSelectionPolicy({ strategy = "weighted-random", freshnessHalfLifeHours = 12, sourceWindow = 20, sourcePriority = {}, rng = Math.random } = {}) {
  return {
    strategy,
    select(eligible, { maxItems, historyStore, now }) {
      const warnings = [];
      if (!eligible.length || maxItems <= 0) return { picks: [], warnings };

      const resolvedTimestamps = eligible.map((c) => resolvePublishedAt(c.item, now, warnings));
      const newestTimestamp = Math.max(now, ...resolvedTimestamps.filter((t) => t != null));
      const recentSourceIds = historyStore.recentSourceIds(sourceWindow);
      const lastSourceId = recentSourceIds[0] ?? null;

      const scored = eligible.map((candidate, index) => {
        const freshness = freshnessWeight(resolvedTimestamps[index], newestTimestamp, freshnessHalfLifeHours);
        const diversity = sourceDiversityWeight(candidate.item.sourceName ?? "unknown", { recentSourceIds, lastSourceId, sourcePriority });
        const quality = CONTENT_QUALITY_WEIGHTS[contentOriginOf(candidate.item)] ?? 0.5;
        const manualPriority = candidate.item.manualPriority ?? 1;
        const score = Math.max(0, freshness * diversity * quality * manualPriority);
        return { ...candidate, score };
      });

      // 競合がない (候補が全部maxItems以内に収まる) 場合は「選ぶ」判断が発生しないので、
      // rngを消費せず score降順で確定的に返す。weighted randomは、maxItemsに収まらない
      // 候補同士が競合するときにだけ働く。
      if (scored.length <= maxItems) {
        return { picks: [...scored].sort((a, b) => b.score - a.score), warnings };
      }

      const picks = [];
      const pool = [...scored];
      while (picks.length < maxItems && pool.length) {
        const usedTopics = new Set(picks.map((p) => p.keys.topicKey).filter(Boolean));
        const usedSources = new Set(picks.map((p) => p.item.sourceName));
        let pickable = pool.filter((c) => !(c.keys.topicKey && usedTopics.has(c.keys.topicKey)) && !usedSources.has(c.item.sourceName));
        if (!pickable.length) pickable = pool; // 制約を満たす候補が尽きたら緩める

        const chosen = strategy === "max-score"
          ? pickable.reduce((best, c) => (c.score > best.score ? c : best), pickable[0])
          : weightedPick(pickable, rng);

        picks.push(chosen);
        pool.splice(pool.indexOf(chosen), 1);
      }
      return { picks, warnings };
    },
  };
}

function weightedPick(candidates, rng) {
  const total = candidates.reduce((sum, c) => sum + c.score, 0);
  if (total <= 0) return candidates[0];
  let r = rng() * total;
  for (const candidate of candidates) {
    r -= candidate.score;
    if (r <= 0) return candidate;
  }
  return candidates[candidates.length - 1];
}
