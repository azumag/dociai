import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { parseFeedXml } from "./electron/main/services/feeds/rss-parser.ts"; export { SafeHttpClient } from "./electron/main/services/feeds/rss-client.ts"; export { FeedService } from "./electron/main/services/feeds/feed-service.ts"; export { TopicService } from "./electron/main/services/topics/topic-service.ts"; export { TodoistClient } from "./electron/main/services/topics/todoist-client.ts";`,
      resolveDir: path.resolve(new URL("../..", import.meta.url).pathname),
      sourcefile: "feed-topic-service-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-feed-topic-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

const rss = `<?xml version="1.0"?><rss><channel><item><title>RSS item</title><description><![CDATA[<b>description</b>]]></description><guid>rss-1</guid><pubDate>2026-07-10T00:00:00Z</pubDate></item></channel></rss>`;
const atom = `<?xml version="1.0"?><feed><entry><id>atom-1</id><title>Atom item</title><summary>summary</summary><link href="https://example.com/atom"/><updated>2026-07-10T00:00:00Z</updated></entry></feed>`;
const publicResolver = async () => ["93.184.216.34"];

function dependencies(config, secrets = {}) {
  return {
    configRepository: { getPublic: async () => ({ config, revision: "test", warnings: [] }) },
    secretStore: { getForService: async (key) => secrets[key] ?? null },
  };
}

test("RSS/Atom parsing is Renderer-independent and rejects malformed XML", async () => {
  const { modules, directory } = await loadModules();
  try {
    const parsedRss = modules.parseFeedXml(rss, "RSS", 2);
    assert.deepEqual(parsedRss[0], { title: "RSS item", link: "", description: "description", publishedAt: "2026-07-10T00:00:00.000Z", guid: "rss-1", sourceName: "RSS", sourceIndex: 2 });
    const parsedAtom = modules.parseFeedXml(atom, "Atom", 3);
    assert.equal(parsedAtom[0].link, "https://example.com/atom");
    assert.equal(parsedAtom[0].guid, "atom-1");
    assert.deepEqual(modules.parseFeedXml("<?xml version=\"1.0\"?><rss><channel></channel></rss>", "empty", 0), []);
    assert.throws(() => modules.parseFeedXml("<rss><broken>", "bad", 0), (error) => error.code === "BAD_REQUEST");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("SafeHttpClient blocks SSRF and clears authorization on cross-host redirects", async () => {
  const { modules, directory } = await loadModules();
  try {
    const calls = [];
    const client = new modules.SafeHttpClient(async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: "https://second.example/feed.xml" } });
      return new Response(rss, { status: 200, headers: { "Content-Type": "application/rss+xml" } });
    }, publicResolver);
    const response = await client.request("https://first.example/feed.xml", { signal: new AbortController().signal, headers: { Authorization: "Bearer private" }, acceptedContentTypes: ["xml"] });
    assert.match(response.body, /RSS item/);
    assert.equal(calls[0].init.headers.Authorization, "Bearer private");
    assert.equal(calls[1].init.headers.Authorization, undefined);
    let fetched = false;
    const privateClient = new modules.SafeHttpClient(async () => { fetched = true; return new Response(rss); }, async () => ["127.0.0.1"]);
    await assert.rejects(privateClient.request("http://localhost/feed", { signal: new AbortController().signal, acceptedContentTypes: ["xml"] }), (error) => error.code === "BAD_REQUEST");
    assert.equal(fetched, false);
    const oversized = new modules.SafeHttpClient(async () => new Response(rss, { status: 200, headers: { "Content-Type": "application/xml", "Content-Length": "999" } }), publicResolver);
    await assert.rejects(oversized.request("https://feed.example/rss", { signal: new AbortController().signal, acceptedContentTypes: ["xml"], maxBytes: 10 }), (error) => error.code === "BAD_REQUEST");

    // issue #188: https->httpへredirectで格下げする侵害/中間者経路を拒否する。
    const downgrading = new modules.SafeHttpClient(async () => new Response(null, { status: 302, headers: { Location: "http://second.example/feed.xml" } }), publicResolver);
    await assert.rejects(downgrading.request("https://first.example/feed.xml", { signal: new AbortController().signal, acceptedContentTypes: ["xml"] }), (error) => error.code === "BAD_REQUEST");

    // issue #188: allowedHosts (source単位のhost allowlist) はredirect先にも適用される。
    let allowlistFetched = false;
    const allowlisted = new modules.SafeHttpClient(async () => { allowlistFetched = true; return new Response(rss, { status: 200, headers: { "Content-Type": "application/xml" } }); }, publicResolver);
    await assert.rejects(allowlisted.request("https://not-allowed.example/rss", { signal: new AbortController().signal, acceptedContentTypes: ["xml"], allowedHosts: ["allowed.example"] }), (error) => error.code === "BAD_REQUEST");
    assert.equal(allowlistFetched, false);
    const allowedResponse = await allowlisted.request("https://sub.allowed.example/rss", { signal: new AbortController().signal, acceptedContentTypes: ["xml"], allowedHosts: ["allowed.example"] });
    assert.match(allowedResponse.body, /RSS item/);

    // issue #188: CGNAT (100.64.0.0/10) もprivate同様に拒否する。
    let cgnatFetched = false;
    const cgnatClient = new modules.SafeHttpClient(async () => { cgnatFetched = true; return new Response(rss); }, async () => ["100.64.0.1"]);
    await assert.rejects(cgnatClient.request("https://cgnat.example/feed", { signal: new AbortController().signal, acceptedContentTypes: ["xml"] }), (error) => error.code === "BAD_REQUEST");
    assert.equal(cgnatFetched, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("FeedService and TopicService use config/secret stores, pagination, error mapping, and cancellation", async () => {
  const { modules, directory } = await loadModules();
  try {
    const feedConfig = dependencies({ news: { sources: [{ type: "rss", name: "RSS", url: "https://feed.example/rss", retries: 0 }] } });
    const feedHttp = new modules.SafeHttpClient(async () => new Response(rss, { status: 200, headers: { "Content-Type": "application/rss+xml" } }), publicResolver);
    const feed = new modules.FeedService(feedConfig.configRepository, feedHttp);
    const feedResult = await feed.fetch({ sourceIndex: 0, requestId: "feed-request" });
    assert.equal(feedResult.items[0].sourceIndex, 0);
    assert.equal(feedResult.requestId, "feed-request");
    assert.equal(feed.runtime.health.snapshot()[0].status, "healthy");

    const calls = [];
    const todoistHttp = new modules.SafeHttpClient(async (url, init) => {
      calls.push({ url, init });
      const parsed = new URL(url);
      if (init.method === "POST") return new Response(null, { status: 204 });
      if (!parsed.searchParams.get("cursor")) return new Response(JSON.stringify({ results: [{ id: "one", content: "topic one", project_id: "p" }], next_cursor: "page-2" }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify([{ id: "two", content: "topic two", project_id: "p" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }, publicResolver);
    const topicsConfig = dependencies({ topics: { sources: [{ type: "todoist", name: "Todoist", projectId: "p", baseUrl: "https://todoist.example/rest/v2", tokenSecretRef: "topics.sources.0.token", retries: 0 }] } }, { "topics.sources.0.token": "token-value" });
    const topics = new modules.TopicService(topicsConfig.configRepository, topicsConfig.secretStore, new modules.TodoistClient(todoistHttp));
    const topicResult = await topics.fetchTopics({ sourceIndex: 0, requestId: "topic-request" });
    assert.deepEqual(topicResult.items.map((item) => item.taskId), ["one", "two"]);
    assert.equal(calls[0].init.headers.Authorization, "Bearer token-value");
    await topics.completeTask({ sourceIndex: 0, taskId: "one", requestId: "complete-request" });
    assert.equal(calls.at(-1).init.method, "POST");
    assert.doesNotMatch(JSON.stringify(topicResult), /token-value/);

    const noToken = dependencies({ topics: { sources: [{ type: "todoist", projectId: "p" }] } });
    await assert.rejects(new modules.TopicService(noToken.configRepository, noToken.secretStore, new modules.TodoistClient(todoistHttp)).fetchTopics({ sourceIndex: 0 }), (error) => error.code === "AUTH");
    for (const [status, code] of [[401, "AUTH"], [403, "AUTH"], [404, "BAD_REQUEST"], [429, "RATE_LIMIT"], [500, "SERVER"]]) {
      const failedHttp = new modules.SafeHttpClient(async () => new Response("{}", { status, headers: { "Content-Type": "application/json" } }), publicResolver);
      await assert.rejects(new modules.TopicService(topicsConfig.configRepository, topicsConfig.secretStore, new modules.TodoistClient(failedHttp)).fetchTopics({ sourceIndex: 0 }), (error) => error.code === code);
    }

    const waitingHttp = new modules.SafeHttpClient(async (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })), publicResolver);
    const cancelledFeed = new modules.FeedService(feedConfig.configRepository, waitingHttp);
    const pending = cancelledFeed.fetch({ sourceIndex: 0, requestId: "cancel-feed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelledFeed.cancel("cancel-feed"), true);
    await assert.rejects(pending, (error) => error.code === "CANCELLED");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
