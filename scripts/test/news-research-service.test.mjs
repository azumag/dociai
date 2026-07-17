import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { NewsSearchService } from "./electron/main/services/news/news-search-service.ts"; export { WikipediaService } from "./electron/main/services/news/wikipedia-service.ts"; export { SafeHttpClient } from "./electron/main/services/feeds/rss-client.ts";`,
      resolveDir: path.resolve(new URL("../..", import.meta.url).pathname),
      sourcefile: "news-research-service-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-news-research-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

const publicResolver = async () => ["93.184.216.34"];

test("NewsSearchService fetches, allowlists news.google.com, and maps feed items to results", async () => {
  const { modules, directory } = await loadModules();
  try {
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title>速報: テストニュース</title><description>詳細な説明文</description><link>https://example.com/article1</link><pubDate>2026-07-10T00:00:00Z</pubDate></item>
    </channel></rss>`;
    let requestedUrl = null;
    const http = new modules.SafeHttpClient(async (url) => {
      requestedUrl = String(url);
      return new Response(rss, { status: 200, headers: { "Content-Type": "application/xml" } });
    }, publicResolver);
    const service = new modules.NewsSearchService(http);

    const response = await service.search({ query: "テストクエリ", language: "ja" });
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0].title, "速報: テストニュース");
    assert.equal(response.results[0].link, "https://example.com/article1");
    assert.ok(requestedUrl.startsWith("https://news.google.com/rss/search?"));
    assert.ok(requestedUrl.includes("q=%E3%83%86%E3%82%B9%E3%83%88%E3%82%AF%E3%82%A8%E3%83%AA"));

    await assert.rejects(service.search({ query: "" }), (error) => error.code === "BAD_REQUEST");

    const blockedHttp = new modules.SafeHttpClient(async () => new Response(rss, { status: 200, headers: { "Content-Type": "application/xml" } }), async () => ["127.0.0.1"]);
    const blockedService = new modules.NewsSearchService(blockedHttp);
    await assert.rejects(blockedService.search({ query: "x" }), (error) => error.code === "BAD_REQUEST");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("NewsSearchService.cancel aborts an in-flight search", async () => {
  const { modules, directory } = await loadModules();
  try {
    const waitingHttp = new modules.SafeHttpClient(
      async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })),
      publicResolver,
    );
    const service = new modules.NewsSearchService(waitingHttp);
    const pending = service.search({ query: "テスト", requestId: "req-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(service.cancel("req-1"), true);
    await assert.rejects(pending, (error) => error.code === "CANCELLED" || error.retryable === false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("WikipediaService picks the language-specific host and returns the first page's summary", async () => {
  const { modules, directory } = await loadModules();
  try {
    const payload = JSON.stringify({ query: { pages: [{ title: "テスト項目", extract: "これは要約です。", fullurl: "https://ja.wikipedia.org/wiki/テスト項目" }] } });
    let requestedUrl = null;
    const http = new modules.SafeHttpClient(async (url) => {
      requestedUrl = String(url);
      return new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } });
    }, publicResolver);
    const service = new modules.WikipediaService(http);

    const response = await service.search({ query: "テスト項目", language: "ja" });
    assert.equal(response.summary.title, "テスト項目");
    assert.equal(response.summary.extract, "これは要約です。");
    assert.ok(requestedUrl.startsWith("https://ja.wikipedia.org/w/api.php?"));

    const enHttp = new modules.SafeHttpClient(async (url) => { requestedUrl = String(url); return new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } }); }, publicResolver);
    const enService = new modules.WikipediaService(enHttp);
    await enService.search({ query: "test", language: "en" });
    assert.ok(requestedUrl.startsWith("https://en.wikipedia.org/w/api.php?"));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("WikipediaService returns a null summary when no page matches, and rejects invalid JSON/queries", async () => {
  const { modules, directory } = await loadModules();
  try {
    const emptyHttp = new modules.SafeHttpClient(async () => new Response(JSON.stringify({ query: {} }), { status: 200, headers: { "Content-Type": "application/json" } }), publicResolver);
    const emptyService = new modules.WikipediaService(emptyHttp);
    const response = await emptyService.search({ query: "存在しない項目" });
    assert.equal(response.summary, null);

    const brokenHttp = new modules.SafeHttpClient(async () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }), publicResolver);
    const brokenService = new modules.WikipediaService(brokenHttp);
    await assert.rejects(brokenService.search({ query: "x" }), (error) => error.code === "BAD_REQUEST");

    await assert.rejects(emptyService.search({ query: "  " }), (error) => error.code === "BAD_REQUEST");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
