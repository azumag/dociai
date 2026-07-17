// QueryBuilder (issue #190): 見出しから検索queryを組み立てる。source suffix・速報prefix・
// 装飾を除去した見出しを基本queryにし、読点/コロンで区切った前半だけの短縮queryを補助にする。
// user promptや記事本文全体は検索queryへ流さない — 見出し文字列だけを入力とする。

const PREFIX_PATTERNS = [
  /^【[^】]{1,12}】/,
  /^(速報|続報|解説|独自|動画|写真|社説|コラム|寄稿)[:：、,\s]*/,
  /^\[[^\]]{1,12}\]/,
];

const SUFFIX_PATTERNS = [/\s*[-|｜–—]\s*[A-Za-z0-9ぁ-んァ-ヶ一-龠ー・]{1,24}$/];

function stripDecorations(headline) {
  let value = String(headline ?? "").normalize("NFKC").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of PREFIX_PATTERNS) {
      const next = value.replace(pattern, "").trim();
      if (next !== value) { value = next; changed = true; }
    }
  }
  for (const pattern of SUFFIX_PATTERNS) value = value.replace(pattern, "").trim();
  return value;
}

export function buildQueries(headline, { maxQueries = 3, maxQueryLength = 120 } = {}) {
  const cleaned = stripDecorations(headline).slice(0, maxQueryLength);
  if (!cleaned) return [];
  const queries = [cleaned];

  const shortened = cleaned.split(/[、:：]/)[0].trim();
  if (shortened && shortened !== cleaned && shortened.length >= 6) queries.push(shortened);

  return queries.slice(0, Math.max(1, maxQueries));
}
