// ニュースリーダー (issue #10)
// RSSからニュース候補を取得し、AIで配信向けの読み上げ文に要約して SpeechQueue に入れる。
// 既読はメモリ上の guid セットで管理し、同じニュースを繰り返し読まない。

const MOCK_NEWS = [
  { title: "ローカルPoCが初起動", description: "配信AIコンパニオンのローカルPoCが初めて起動し、コメントへの音声応答に成功した。", guid: "mock-1" },
  { title: "モックニュース機能のテスト", description: "APIキーなしで動作確認できるモックニュースソースが追加された。", guid: "mock-2" },
  { title: "次はOBS連携へ", description: "開発ロードマップによると、次の焦点はOBSブラウザソース連携だという。", guid: "mock-3" },
];

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html ?? "";
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
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
  async run() {
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
      const items = await this.fetchAll();
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
        const { messages, debugText } = this.contextBuilder.build({ persona, news: item, includeScreen: "never" });
        const { text } = await connector.chat(messages);
        this.readGuids.add(item.guid);
        this.onRead({ persona, item, text, debugText });
        this.speechQueue.enqueue({ personaId: persona.id, personaName: persona.name, text, voice: persona.voice });
      }
    } finally {
      this.busy = false;
    }
  }

  async fetchAll() {
    const out = [];
    for (const src of this.config.news?.sources ?? []) {
      try {
        out.push(...(await this.fetchSource(src)));
      } catch (e) {
        const corsHint = e.name === "TypeError" || /Failed to fetch/i.test(e.message)
          ? " (ブラウザのCORS制限の可能性があります。news.corsProxy の設定を検討してください)"
          : "";
        this.log(`ニュース取得失敗 [${src.name}]: ${e.message}${corsHint}`, "error");
      }
    }
    return out;
  }

  async fetchSource(src) {
    if (src.type === "mock") return [...MOCK_NEWS];
    if (src.type !== "rss") throw new Error(`未対応のソース種別 "${src.type}"`);

    const proxy = this.config.news?.corsProxy ?? "";
    const url = proxy ? proxy + encodeURIComponent(src.url) : src.url;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
    if (xml.querySelector("parsererror")) throw new Error("RSS/XMLの解析に失敗しました");

    // RSS 2.0 (<item>) と Atom (<entry>) の両対応
    const items = [...xml.querySelectorAll("item, entry")].map((node) => {
      const pick = (sel) => node.querySelector(sel)?.textContent?.trim() ?? "";
      const title = pick("title");
      const link = pick("link") || node.querySelector("link")?.getAttribute("href") || "";
      const description = stripHtml(pick("description") || pick("summary") || pick("content")).slice(0, 300);
      const guid = pick("guid") || pick("id") || link || title;
      return { title, link, description, guid, sourceName: src.name };
    }).filter((i) => i.title);

    return items;
  }

  status() {
    return {
      enabled: this.enabled,
      busy: this.busy,
      readCount: this.readGuids.size,
      lastRunAt: this.lastRunAt,
    };
  }
}
