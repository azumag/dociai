// ModeValidator (issue #192): simpleでの意見混入、currentでの単一視点断定、topicでの
// 背景水増しを検査する。

const OPINION_MARKERS = [/と思(う|います)/, /かもしれない/, /予想され(る|ます)/, /見込まれ(る|ます)/, /私は.{0,10}考え(る|ます)/];
const HEDGE_WORDS = ["一方", "という見方", "という声", "との指摘", "とみる向きも", "見方もある"];

export function validateMode(text, { policy, research } = {}) {
  const failures = [];
  if (!policy) return { failures };

  if (policy.mode === "simple" && !policy.allowOpinion) {
    const hit = OPINION_MARKERS.find((pattern) => pattern.test(text));
    if (hit) failures.push({ code: "simple_mode_opinion", severity: "rewrite", detail: hit.source });
  }

  if (policy.mode === "current" && policy.requireMultipleViewpoints && (research?.viewpoints?.length ?? 0) >= 2) {
    if (!HEDGE_WORDS.some((word) => text.includes(word))) {
      failures.push({ code: "current_mode_single_viewpoint", severity: "warning" });
    }
  }

  if (policy.mode === "topic" && !research && policy.targetChars?.max && text.length > policy.targetChars.max * 1.5) {
    failures.push({ code: "topic_mode_padding", severity: "warning" });
  }

  return { failures };
}
