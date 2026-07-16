// spam gate (issue #189)。deterministic heuristicsを1段目、任意のLLM classifierを2段目とする。
// classifierのtimeout/errorは「読む側へ倒す」(uncertain扱い、除外しない) — スパム判定の
// 過検出でニュース全体を止めないことを優先する。

const SPAM_MARKERS = [
  /\bpr\b/i,
  /【\s*pr\s*】/i,
  /\bsponsored\b/i,
  /\baffiliate\b/i,
  /advertorial/i,
  /広告/,
  /プロモーション/,
  /タイアップ/,
  /クーポン/,
  /割引コード/,
  /promo\s*code/i,
  /\d+\s*%\s*off/i,
  /今すぐ購入/,
  /今だけ.{0,6}(割引|セール)/,
];

function hasSpamMarker(text) {
  return SPAM_MARKERS.some((pattern) => pattern.test(text));
}

// 同一token (brand名・型番等) がタイトル中で不自然に反復するSEO keyword stuffingを検知する。
function isKeywordStuffed(title) {
  const tokens = String(title ?? "").split(/[\s、,・]+/).filter((t) => t.length >= 2);
  if (tokens.length < 6) return false;
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return [...counts.values()].some((count) => count >= 4 && count / tokens.length >= 0.4);
}

export function createSpamGate({ classifier = null } = {}) {
  return {
    async classify(item) {
      const text = `${item.title ?? ""} ${item.description ?? ""}`;
      if (hasSpamMarker(text)) return { verdict: "spam", reasonCode: "marker" };
      if (isKeywordStuffed(item.title)) return { verdict: "spam", reasonCode: "keyword_stuffing" };
      if (!classifier) return { verdict: "news", reasonCode: "no_classifier" };
      try {
        const result = await classifier.classify(item);
        const verdict = result?.verdict;
        if (verdict === "news" || verdict === "spam" || verdict === "uncertain") return { verdict, reasonCode: result.reasonCode ?? "classifier", classifier: classifier.id };
        return { verdict: "uncertain", reasonCode: "classifier_empty", classifier: classifier.id };
      } catch {
        return { verdict: "uncertain", reasonCode: "classifier_error", classifier: classifier.id };
      }
    },
  };
}
