// topicKey: 同じ出来事について見出しが変わっても連続読み上げを止めるためのkey (issue #189)。
// 完全なNLP分かち書きはせず、既知prefix/bracketの除去 + 記号除去だけの軽量heuristicにとどめ、
// 短くなりすぎたkeyは「無効」として呼び出し側にdedupe判定をスキップさせる。

const TOPIC_PREFIX_PATTERNS = [
  /^【[^】]{1,12}】/, // 【速報】【独自】【解説】等
  /^(速報|続報|解説|独自|動画|写真|社説|コラム|寄稿)[:：、,\s]*/,
  /^\[[^\]]{1,12}\]/, // [Breaking] 等
];

export function normalizeTopicKey(title, { minLength = 6, maxLength = 80 } = {}) {
  let value = String(title ?? "").normalize("NFKC");
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of TOPIC_PREFIX_PATTERNS) {
      const next = value.replace(pattern, "");
      if (next !== value) {
        value = next;
        changed = true;
      }
    }
  }
  value = value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\p{P}\p{S}\s]/gu, "")
    .slice(0, maxLength);
  return value.length >= minLength ? value : null;
}
