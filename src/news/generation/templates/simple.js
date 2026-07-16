// simple mode (issue #191): 300〜800字既定、確認できた事実だけ。意見・推測を禁止する。
export function buildSimpleInstructions(policy) {
  return [
    `${policy.targetChars.min}〜${policy.targetChars.max}字程度で書いてください。`,
    "確認できた事実だけを説明してください。",
    "独自の考察、未来予測、断定的な評価はしないでください。",
    "根拠が不十分な場合は、無理に長くせず短く終えてください。",
  ].join("\n");
}
