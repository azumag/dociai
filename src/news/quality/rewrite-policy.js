// RewriteDecision (issue #192): quality gateの結果からaccept/rewrite/rejectを決める。
// generation側のconnector error retry (readers/retry-policy.js) とは別カウント。

export function decideRewrite(qualityReport, { attempt = 0, maxAttempts = 1 } = {}) {
  if (qualityReport.passed) return { action: "accept", reasonCodes: [], maxAttempts };
  const reasonCodes = qualityReport.failures.filter((f) => f.severity === "rewrite").map((f) => f.code);
  if (!reasonCodes.length) return { action: "accept", reasonCodes: [], maxAttempts }; // warning止まりの失敗はrewriteしない
  if (attempt < maxAttempts) return { action: "rewrite", reasonCodes, maxAttempts };
  return { action: "reject", reasonCodes, maxAttempts };
}
