const OUTPUT_LIMIT_FINISH_REASONS = new Set(["length", "max_tokens", "max_output_tokens", "token_limit"]);

export function isOutputLimitFinishReason(value) {
  return OUTPUT_LIMIT_FINISH_REASONS.has(String(value ?? "").toLowerCase());
}

export function buildOutputLimitWarning(finishReason, connectorId) {
  return `AI応答は出力上限 (${finishReason}) で終了しました。読み上げ処理による切断ではありません。コネクタ「${connectorId}」の maxTokens を増やしてください。`;
}
