// ニュースリーダー (issue #10)
// RSSからニュース候補を取得し、AIで配信向けの読み上げ文に要約して SpeechQueue に入れる。
// 既読はメモリ上の guid セットで管理し、同じニュースを繰り返し読まない。

import { cancelElectronFeedRequest, fetchFeedThroughElectron, hasElectronFeedService } from "./platform/electron-services.js";
import { RequestCancelledError, isCancellation } from "./runtime/request-registry.js";

const MOCK_NEWS = [
  { title: "ローカルPoCが初起動", description: "配信AIコンパニオンのローカルPoCが初めて起動し、コメントへの音声応答に成功した。", guid: "mock-1", publishedAt: "2026-07-01T09:00:00+09:00", sourceName: "mock" },
  { title: "モックニュース機能のテスト", description: "APIキーなしで動作確認できるモックニュースソースが追加された。", guid: "mock-2", publishedAt: "2026-07-01T09:05:00+09:00", sourceName: "mock" },
  { title: "次はOBS連携へ", description: "開発ロードマップによると、次の焦点はOBSブラウザソース連携だという。", guid: "mock-3", publishedAt: "2026-07-01T09:10:00+09:00", sourceName: "mock" },
  { title: "ローカル PoC が初起動！", description: "別ソースでも同じニュースが配信された。", guid: "mock-duplicate", publishedAt: "2026-07-01T09:03:00+09:00", sourceName: "mock-alt" },
];

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html ?? "";
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTitle(title) {
  return (title ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

function parseDate(value) {
  const t = Date.parse(value ?? "");
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export class NewsReader {
  constructor({ config, getConnector, personaRouter, contextBuilder, speechQueue, log = () => {}, onRead = () => {} }) {
    this.config = config;
    this.getConnector = getConnector;
    this.personaRouter = personaRouter;
    this.contextBuilder = contextBuilder;
    this.speechQueue = speechQueue;
    this.log = log;
    this.onRead = onRead;
    this.readGuids = new Set();
    this.busy = false;
    this.lastRunAt = null;
  }

  get enabled() {
    return !!this.config.news?.enabled;
  }

  // トリガー (interval/manual) から呼ばれるエントリポイント
  async run(context = {}) {
    const news = this.config.news;
    if (!news?.enabled) {
      this.log("ニュース機能は無効です (news.enabled: false)");
      return;
    }
    if (this.busy) {
      this.log("ニュース処理が進行中のためスキップしました");
      return;
    }
    this.busy = true;
    this.lastRunAt = new Date();
    try {
      this.#guard(context);
      const items = await this.fetchAll(context);
      const unread = items.filter((i) => !this.readGuids.has(i.guid));
      const picks = unread.slice(0, news.maxItems ?? 3);
      this.log(`ニュース候補 ${items.length}件 (未読 ${unread.length}件、読み上げ ${picks.length}件)`);
      if (!picks.length) return;

      const persona = (news.persona && this.personaRouter.get(news.persona)) || this.personaRouter.defaultPersona();
      if (!persona) throw new Error("ニュース読み上げに使えるペルソナがありません");
      if (!persona.enabled) {
        this.log(`ニュース担当ペルソナ「${persona.name}」が無効化中のためスキップしました`);
        return;
      }
      const connector = this.getConnector(persona.connector);

      for (const item of picks) {
        this.#guard(context);
        const { messages, debugText } = this.contextBuilder.build({ persona, news: item, includeScreen: "never" });
        try {
          const { text } = await connector.chat(messages, { signal: context.signal, requestId: `${context.requestId ?? "news"}:summary:${item.guid}`, generation: context.generation });
          this.#guard(context);
          this.readGuids.add(item.guid);
          this.#guard(context);
          this.onRead({ persona, item, text, debugText });
          this.#guard(context);
          this.speechQueue.enqueue({ personaId: persona.id, personaName: persona.name, text, voice: persona.voice });
        } catch (e) {
          if (isCancellation(e)) throw e;
          this.log(`ニュース1件の読み上げ失敗 [${item.title}]: ${e.message}`, "error");
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async fetchAll(context = {}) {
    const out = [];
    const sources = (this.config.news?.sources ?? []).map((src, index) => ({ src, index })).filter(({ src }) => src.enabled !== false);
    for (const { src, index } of sources) {
      try {
        out.push(...(await this.fetchSource(src, index, context)));
      } catch (e) {
        if (isCancellation(e)) throw e;
        const corsHint = e.name === "TypeError" || /Failed to fetch/i.test(e.message)
          ? " (ブラウザのCORS制限の可能性があります。news.corsProxy の設定を検討してください)"
          : "";
        this.log(`ニュース取得失敗 [${src.name}]: ${e.message}${corsHint}`, "error");
      }
    }
    return this.refineItems(out);
  }

  async fetchSource(src, sourceIndex, context = {}) {
    if (src.type === "mock") return [...MOCK_NEWS];
    if (src.type !== "rss") throw new Error(`未対応のソース種別 "${src.type}"`);

    if (hasElectronFeedService()) {
      const requestId = `${context.requestId ?? "news"}:feed:${sourceIndex}`;
      const cancel = () => { void cancelElectronFeedRequest(requestId); };
      context.signal?.addEventListener("abort", cancel, { once: true });
      const result = await fetchFeedThroughElectron({ sourceIndex, requestId, ownerId: "console" }).finally(() => context.signal?.removeEventListener("abort", cancel));
      if (!result?.ok) {
        if (result?.error?.code === "CANCELLED") throw new RequestCancelledError();
        throw new Error(result?.error?.message ?? "Main processからニュースを取得できませんでした");
      }
      this.#guard(context);
      return result.value.items;
    }

    const proxy = this.config.news?.corsProxy ?? "";
    if (proxy) this.log("news.corsProxy はBrowser版の互換設定です。Electron版ではMain process通信へ移行済みのため使用されません", "warn");
    const url = proxy ? proxy + encodeURIComponent(src.url) : src.url;
    const res = await fetch(url, { signal: context.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
    if (xml.querySelector("parsererror")) throw new Error("RSS/XMLの解析に失敗しました");

    // RSS 2.0 (<item>) と Atom (<entry>) の両対応
    const items = [...xml.querySelectorAll("item, entry")].map((node) => {
      const pick = (sel) => node.querySelector(sel)?.textContent?.trim() ?? "";
      const title = pick("title");
      const link = pick("link") || node.querySelector("link")?.getAttribute("href") || "";
      const description = stripHtml(pick("description") || pick("summary") || pick("content")).slice(0, 300);
      const publishedAt = parseDate(pick("pubDate") || pick("published") || pick("updated") || pick("dc\\:date"));
      const guid = pick("guid") || pick("id") || link || title;
      return { title, link, description, publishedAt, guid, sourceName: src.name };
    }).filter((i) => i.title);

    return items;
  }

  refineItems(items) {
    const news = this.config.news ?? {};
    const seen = new Set();
    const refined = [];
    for (const item of items) {
      const key = normalizeTitle(item.title);
      if (news.dedupe !== false && key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      refined.push({ ...item, normalizedTitle: key });
    }
    refined.sort((a, b) => {
      const bt = Date.parse(b.publishedAt ?? "") || 0;
      const at = Date.parse(a.publishedAt ?? "") || 0;
      return bt - at;
    });
    return refined;
  }

  status() {
    return {
      enabled: this.enabled,
      busy: this.busy,
      readCount: this.readGuids.size,
      lastRunAt: this.lastRunAt,
    };
  }

  #guard(context) {
    if (context.signal?.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new RequestCancelledError();
    if (context.isCurrent && !context.isCurrent()) throw new RequestCancelledError("ニュース処理は設定変更で停止しました", "stale-generation");
  }
}
