// rewrite prompt (issue #191/#192連携): quality gateの失敗codeだけを渡し、前回出力の使い回しを
// 禁止して全文を書き直させる。失敗本文全体ではなく短いsnippetだけを渡す契約 (issue #192)。

export function buildRewriteAddendum(feedback = []) {
  const reasons = (feedback ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.message ?? entry?.code))
    .filter(Boolean);
  if (!reasons.length) return "";
  return [
    "# 前回出力のやり直し",
    "前回の出力には次の問題がありました。前回の文章は使い回さず、全文を新しく書き直してください。",
    ...reasons.map((reason) => `- ${reason}`),
  ].join("\n");
}
