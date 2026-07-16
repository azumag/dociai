// Article extractor (issue #188)。
// 依存を増やしすぎないpure extractor — DOM実装(DOMParser/cheerio/jsdom等)を使わず、
// 正規表現とscore付けだけで本文候補を抜き出す。Electron Main processにDOM APIは
// 無く、新規npm依存も追加しない (issueの明示方針)。将来Readability系libraryへ
// 差し替える場合も、入力サイズ上限・timeoutはservice側 (article-fetcher.ts) が持つ。

const REMOVE_BLOCK_TAGS = ["script", "style", "noscript", "svg", "form", "iframe", "template"];
const STRUCTURAL_NOISE_TAGS = ["nav", "header", "footer", "aside"];

const BOILERPLATE_PATTERNS = [
  /cookie/i,
  /クッキー(を使用|ポリシー)/,
  /関連記事/,
  /この記事もおすすめ/,
  /シェア(する)?$/,
  /(twitter|facebook|line)で(共有|シェア)/i,
  /会員限定/,
  /続きを読むには/,
  /購読(はこちら|する)/,
  /メールマガジン登録/,
  /この記事を読んだ人はこんな記事も読んでいます/,
];

const MIN_PARAGRAPH_CHARS = 40;
const MAX_LINK_TEXT_RATIO = 0.5;
const MIN_TOTAL_CHARS = 200;
const MAX_TOTAL_CHARS = 20_000;

function removeBlocks(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  return out;
}

function extractRegion(html: string): string {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article?.[1]) return article[1];
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ?? html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[a-zA-Z0-9]+>/i);
  if (main?.[1]) return main[1];
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body?.[1] ?? html;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function linkTextLength(blockHtml: string): number {
  const matches = [...blockHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
  return matches.reduce((sum, match) => sum + stripTags(match[1]).length, 0);
}

function isBoilerplate(text: string): boolean {
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

// paragraph候補 (<p>/<li>/見出し) を出現順に抜き出し、文字数・link密度・定型句でfilterする。
function extractParagraphs(regionHtml: string): string[] {
  const blocks = [...regionHtml.matchAll(/<(p|li|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const paragraphs: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const blockHtml = block[2];
    const text = stripTags(blockHtml);
    if (text.length < MIN_PARAGRAPH_CHARS) continue;
    const linkRatio = text.length ? linkTextLength(blockHtml) / text.length : 0;
    if (linkRatio > MAX_LINK_TEXT_RATIO) continue;
    if (isBoilerplate(text)) continue;
    if (seen.has(text)) continue; // 同一paragraph反復を除去
    seen.add(text);
    paragraphs.push(text);
  }
  return paragraphs;
}

export type ExtractedArticle = { text: string } | null;

// html全体から本文候補を抜き出す。min 200文字に満たない場合はnull (feed summaryへ
// fallbackさせる呼び出し側の合図)。
export function extractArticleText(html: string): ExtractedArticle {
  const withoutScripts = removeBlocks(html, REMOVE_BLOCK_TAGS);
  const region = removeBlocks(extractRegion(withoutScripts), STRUCTURAL_NOISE_TAGS);
  const paragraphs = extractParagraphs(region);
  const text = paragraphs.join("\n\n").slice(0, MAX_TOTAL_CHARS);
  if (text.length < MIN_TOTAL_CHARS) return null;
  return { text };
}
