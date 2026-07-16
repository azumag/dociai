// dedupe順序 (issue #189):
//   1. 必須identity欠落を除外
//   2. current batch title/url exact duplicate
//   3. persistent delivered title/url duplicate
//   4. recent topic duplicate
//   (5. processing storeのread/skipped/permanent除外は呼び出し側のcandidateKeysで担保済み)
//   6. spam gate
// 除外理由をNewsFilterStatsへ集計する。

import { normalizeTitleKey } from "./normalize-news-key.js";
import { normalizeTopicKey } from "./topic-key.js";
import { computeUrlHash } from "./normalize-news-key.js";

export function emptyFilterStats() {
  return { missingIdentity: 0, duplicateTitle: 0, duplicateTopic: 0, duplicateUrl: 0, pastTitle: 0, pastTopic: 0, pastUrl: 0, spam: 0 };
}

export function deriveIdentityKeys(item, { sourceSuffixPatterns } = {}) {
  const titleKey = normalizeTitleKey(item.title, { sourceSuffixPatterns }) || null;
  const topicKey = normalizeTopicKey(item.title);
  const urlHash = computeUrlHash(item.canonicalUrl ?? item.link ?? "");
  return { titleKey, topicKey, urlHash };
}

export async function filterCandidates({ items, candidateKeys, historyStore, spamGate, now, topicCooldownMs, sourceSuffixPatterns }) {
  const stats = emptyFilterStats();
  const seenTitleKeys = new Set();
  const seenUrlHashes = new Set();
  const eligible = [];

  for (const item of items) {
    if (!candidateKeys.has(item.processingKey)) continue;

    const keys = deriveIdentityKeys(item, { sourceSuffixPatterns });
    if (!keys.titleKey) {
      stats.missingIdentity++;
      continue;
    }
    if (seenTitleKeys.has(keys.titleKey)) {
      stats.duplicateTitle++;
      continue;
    }
    if (keys.urlHash && seenUrlHashes.has(keys.urlHash)) {
      stats.duplicateUrl++;
      continue;
    }
    if (historyStore.hasDeliveredTitle(keys.titleKey)) {
      stats.pastTitle++;
      continue;
    }
    if (keys.urlHash && historyStore.hasDeliveredUrl(keys.urlHash)) {
      stats.pastUrl++;
      continue;
    }
    if (keys.topicKey && historyStore.hasRecentTopic(keys.topicKey, now, topicCooldownMs)) {
      stats.pastTopic++;
      continue;
    }
    if (keys.titleKey && historyStore.hasRecentSpam(keys.titleKey, now, topicCooldownMs)) {
      stats.spam++;
      continue;
    }

    const spamDecision = await spamGate.classify(item);
    if (spamDecision.verdict === "spam") {
      stats.spam++;
      historyStore.recordSpam({ candidateId: item.processingKey, titleKey: keys.titleKey, topicKey: keys.topicKey, sourceId: item.sourceName ?? "unknown" }, now);
      continue;
    }

    seenTitleKeys.add(keys.titleKey);
    if (keys.urlHash) seenUrlHashes.add(keys.urlHash);
    eligible.push({ item, keys, spamDecision });
  }

  return { eligible, stats };
}
