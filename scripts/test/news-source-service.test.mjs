import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { extractCanonicalUrl } from "./electron/main/services/news/canonical-url.ts"; export { extractArticleText } from "./electron/main/services/news/article-extractor.ts"; export { isHostAllowed, shouldFetchArticle } from "./electron/main/services/news/source-policy.ts"; export { NewsSourceCache } from "./electron/main/services/news/source-cache.ts"; export { fetchArticle } from "./electron/main/services/news/article-fetcher.ts"; export { NewsSourceService } from "./electron/main/services/news/news-source-service.ts"; export { SafeHttpClient } from "./electron/main/services/feeds/rss-client.ts";`,
      resolveDir: path.resolve(new URL("../..", import.meta.url).pathname),
      sourcefile: "news-source-service-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-news-source-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

const publicResolver = async () => ["93.184.216.34"];

function dependencies(config) {
  return { configRepository: { getPublic: async () => ({ config, revision: "test", warnings: [] }) } };
}

test("extractCanonicalUrl prefers <link rel=canonical>, falls back to og:url, then the fetched URL", async () => {
  const { modules, directory } = await loadModules();
  try {
    const withCanonical = '<html><head><link rel="canonical" href="https://example.com/real"><meta property="og:url" content="https://example.com/og"></head></html>';
    assert.equal(modules.extractCanonicalUrl(withCanonical, "https://example.com/fetched"), "https://example.com/real");
    const withOgOnly = '<html><head><meta property="og:url" content="https://example.com/og"></head></html>';
    assert.equal(modules.extractCanonicalUrl(withOgOnly, "https://example.com/fetched"), "https://example.com/og");
    assert.equal(modules.extractCanonicalUrl("<html></html>", "https://example.com/fetched"), "https://example.com/fetched");
    const relative = '<html><head><link rel="canonical" href="/real-path"></head></html>';
    assert.equal(modules.extractCanonicalUrl(relative, "https://example.com/fetched"), "https://example.com/real-path");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("extractArticleText prefers <article>, strips script/style/nav/footer and boilerplate, and dedupes repeated paragraphs", async () => {
  const { modules, directory } = await loadModules();
  try {
    const paragraph = (text) => `<p>${text}</p>`;
    const bodyParagraphs = Array.from({ length: 6 }, (_, i) => paragraph(`これは記事本文の段落その${i + 1}です。十分な長さのある自然な文章をここに書いています。`)).join("");
    const html = `<html><head><script>evil()</script><style>.x{}</style></head><body>
      <nav>${paragraph("ホーム メニュー お問い合わせなどのナビゲーション文言がここに並びます。")}</nav>
      <header>${paragraph("サイトのヘッダー領域に表示される長めの見出しテキストがここに入ります。")}</header>
      <article>
        ${bodyParagraphs}
        <p>Cookieポリシーについてはこちらをご確認くださいという定型的な案内文です。</p>
        <p>この記事もおすすめですという関連記事への誘導文がここに表示されます。</p>
        <p><a href="/a">リンクテキストだけがほとんどを占める段落です</a>のようなリンク密度の高いテキスト</p>
        ${paragraph("これは記事本文の段落その1です。十分な長さのある自然な文章をここに書いています。")}
      </article>
      <footer>${paragraph("フッターに表示される著作権表示やサイトマップへのリンク文言です。")}</footer>
    </body></html>`;
    const extracted = modules.extractArticleText(html);
    assert.ok(extracted, "well-formed article content must be extracted");
    assert.doesNotMatch(extracted.text, /evil\(\)/);
    assert.doesNotMatch(extracted.text, /ナビゲーション|ヘッダー領域|フッターに表示/);
    assert.doesNotMatch(extracted.text, /Cookieポリシー|この記事もおすすめ/);
    assert.doesNotMatch(extracted.text, /リンクテキストだけが/);
    assert.equal((extracted.text.match(/段落その1です/g) ?? []).length, 1, "the duplicated first paragraph must be deduped");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("extractArticleText returns null when the extractable content is below the minimum length", async () => {
  const { modules, directory } = await loadModules();
  try {
    assert.equal(modules.extractArticleText("<html><body><p>短い</p></body></html>"), null);
    assert.equal(modules.extractArticleText("<html><body></body></html>"), null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("source-policy: isHostAllowed matches exact host and subdomains; shouldFetchArticle honors never/auto/required", async () => {
  const { modules, directory } = await loadModules();
  try {
    assert.equal(modules.isHostAllowed("https://example.com/a", ["example.com"]), true);
    assert.equal(modules.isHostAllowed("https://news.example.com/a", ["example.com"]), true);
    assert.equal(modules.isHostAllowed("https://evil.com/a", ["example.com"]), false);
    assert.equal(modules.isHostAllowed("https://example.com/a", undefined), true);
    assert.equal(modules.isHostAllowed("not a url", ["example.com"]), false);

    assert.equal(modules.shouldFetchArticle("never", false), false);
    assert.equal(modules.shouldFetchArticle("required", true), true);
    assert.equal(modules.shouldFetchArticle("auto", true), false, "auto skips article fetch when feed content is already sufficient");
    assert.equal(modules.shouldFetchArticle("auto", false), true);
    assert.equal(modules.shouldFetchArticle(undefined, false), true, "default mode is auto");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("NewsSourceCache expires positive entries by TTL, honors a shorter negative-cache TTL, and clear() empties both", async () => {
  const { modules, directory } = await loadModules();
  try {
    const now = { value: 0 };
    const cache = new modules.NewsSourceCache(1000, 100, () => now.value);
    cache.set("a", { canonicalUrl: "https://example.com/a", contentText: "text" });
    assert.equal(cache.get("a").value.contentText, "text");
    now.value = 999;
    assert.ok(cache.get("a"), "still within TTL");
    now.value = 1001;
    assert.equal(cache.get("a"), null, "expired positive entry is gone");

    now.value = 0;
    cache.setNegative("b");
    assert.equal(cache.get("b").value, null);
    now.value = 101;
    assert.equal(cache.get("b"), null, "expired negative entry is gone");

    cache.set("c", { canonicalUrl: "https://example.com/c", contentText: "text" });
    cache.clear();
    assert.equal(cache.get("c"), null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("fetchArticle rejects disallowed hosts before any network call and extracts canonical/body from an allowed host", async () => {
  const { modules, directory } = await loadModules();
  try {
    let fetched = false;
    const http = new modules.SafeHttpClient(async () => { fetched = true; return new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }); }, publicResolver);
    const context = { signal: new AbortController().signal };
    await assert.rejects(modules.fetchArticle("https://evil.com/a", http, context, { allowedHosts: ["example.com"] }), (error) => error.code === "BAD_REQUEST");
    assert.equal(fetched, false);

    const bodyParagraphs = Array.from({ length: 6 }, (_, i) => `<p>これは記事本文の段落その${i + 1}です。十分な長さのある自然な文章をここに書いています。</p>`).join("");
    const html = `<html><head><link rel="canonical" href="https://example.com/canonical"></head><body><article>${bodyParagraphs}</article></body></html>`;
    const okHttp = new modules.SafeHttpClient(async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }), publicResolver);
    const article = await modules.fetchArticle("https://example.com/a", okHttp, context, { allowedHosts: ["example.com"] });
    assert.equal(article.canonicalUrl, "https://example.com/canonical");
    assert.match(article.contentText, /段落その1/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("fetchArticle rejects with EMPTY when no extractable content is found", async () => {
  const { modules, directory } = await loadModules();
  try {
    const http = new modules.SafeHttpClient(async () => new Response("<html><body><p>短い</p></body></html>", { status: 200, headers: { "Content-Type": "text/html" } }), publicResolver);
    await assert.rejects(modules.fetchArticle("https://example.com/a", http, { signal: new AbortController().signal }), (error) => error.code === "EMPTY");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("NewsSourceService caches a successful fetch (no re-fetch), negative-caches a failure, and supports cancellation", async () => {
  const { modules, directory } = await loadModules();
  try {
    const bodyParagraphs = Array.from({ length: 6 }, (_, i) => `<p>これは記事本文の段落その${i + 1}です。十分な長さのある自然な文章をここに書いています。</p>`).join("");
    const html = `<html><body><article>${bodyParagraphs}</article></body></html>`;
    let calls = 0;
    const config = dependencies({ news: { sources: [{ type: "rss", name: "src", url: "https://example.com/rss", retries: 0 }] } });
    const http = new modules.SafeHttpClient(async () => { calls++; return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }); }, publicResolver);
    const service = new modules.NewsSourceService(config.configRepository, http);

    const first = await service.fetchArticle({ sourceIndex: 0, url: "https://example.com/a", requestId: "req-1" });
    assert.match(first.article.contentText, /段落その1/);
    assert.equal(calls, 1);
    assert.equal(service.runtime.health.snapshot()[0].status, "healthy");

    const second = await service.fetchArticle({ sourceIndex: 0, url: "https://example.com/a", requestId: "req-2" });
    assert.equal(second.article.contentText, first.article.contentText);
    assert.equal(calls, 1, "a cached URL must not be re-fetched");

    const failingHttp = new modules.SafeHttpClient(async () => new Response("boom", { status: 500 }), publicResolver);
    const failingService = new modules.NewsSourceService(config.configRepository, failingHttp);
    await assert.rejects(failingService.fetchArticle({ sourceIndex: 0, url: "https://example.com/fail" }), (error) => error.code === "SERVER");
    await assert.rejects(failingService.fetchArticle({ sourceIndex: 0, url: "https://example.com/fail" }), (error) => error.code === "UNAVAILABLE", "a negative-cached URL fails fast without a second network attempt");

    const waitingHttp = new modules.SafeHttpClient(async (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })), publicResolver);
    const cancellableService = new modules.NewsSourceService(config.configRepository, waitingHttp);
    const pending = cancellableService.fetchArticle({ sourceIndex: 0, url: "https://example.com/slow", requestId: "cancel-me" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancellableService.cancel("cancel-me"), true);
    await assert.rejects(pending, (error) => error.code === "CANCELLED");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
