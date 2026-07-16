// ToneValidator (issue #192): 視聴者不在の自虐、安価な煽り、設定可能な禁止語を検査する。
// sanitizerが表層 (URL/markdown/tool log) を機械的に除去するのに対し、こちらは意味レベルの
// 口調違反を検出し、rewriteへ回すかどうかの判断材料にする。

const SELF_DEPRECATION_PATTERNS = [/どうせ誰も見て(い)?ない/, /誰も聞いてない/, /視聴者はいない/];
const CHEAP_INCITEMENT_PATTERNS = [/絶対に許せない/, /炎上必至/, /叩くべき/];

export function validateTone(text, { bannedPhrases = [] } = {}) {
  const failures = [];
  for (const pattern of SELF_DEPRECATION_PATTERNS) {
    if (pattern.test(text)) failures.push({ code: "self_deprecating_tone", severity: "rewrite", detail: pattern.source });
  }
  for (const pattern of CHEAP_INCITEMENT_PATTERNS) {
    if (pattern.test(text)) failures.push({ code: "cheap_incitement", severity: "rewrite", detail: pattern.source });
  }
  for (const phrase of bannedPhrases) {
    if (phrase && text.includes(phrase)) failures.push({ code: "banned_phrase", severity: "rewrite", detail: phrase });
  }
  return { failures };
}
