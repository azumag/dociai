// レガシーNewsReader挙動のアダプタ (issue #187)。
// feed取得・refine・prompt組み立て・connector呼び出し・音声enqueueという、pipeline化以前の
// NewsReaderが1クラスで行っていた処理をそのまま関数として持つ。最初のPRではここが唯一の
// 挙動オーナーであり、stageはこのアダプタへ委譲するだけにして「挙動を変えない」を保証する。
// 後続issueが1関数ずつ専用実装へ置き換える (acquire/select -> #188/#189, research -> #190,
// generate/quality -> #191/#192)。

import { cancelElectronFeedRequest, fetchFeedThroughElectron, hasElectronFeedService } from "../../platform/electron-services.js";
import { RequestCancelledError, isCancellation } from "../../runtime/request-registry.js";
import { createReaderItemKey } from "../../readers/reader-runner.js";
import { buildOutputLimitWarning, isOutputLimitFinishReason } from "../../ai-finish-reason.js";
import { guardPipelineContext } from "../contracts.js";

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

export function createLegacyNewsAdapter({ getConfig, getConnector, personaRouter, contextBuilder, speechQueue, log = () => {} }) {
  async function fetchSource(src, sourceIndex, context = {}) {
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
      guardPipelineContext(context);
      return result.value.items;
    }

    const config = getConfig();
    const proxy = config.news?.corsProxy ?? "";
    if (proxy) log("news.corsProxy はBrowser版の互換設定です。Electron版ではMain process通信へ移行済みのため使用されません", "warn");
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

  function refineItems(items) {
    const news = getConfig().news ?? {};
    const seen = new Set();
    const refined = [];
    for (const item of items) {
      const key = normalizeTitle(item.title);
      if (news.dedupe !== false && key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      refined.push({ ...item, normalizedTitle: key, processingKey: createReaderItemKey(item, "news") });
    }
    refined.sort((a, b) => {
      const bt = Date.parse(b.publishedAt ?? "") || 0;
      const at = Date.parse(a.publishedAt ?? "") || 0;
      return bt - at;
    });
    return refined;
  }

  async function fetchAll(context = {}) {
    const config = getConfig();
    const out = [];
    const sources = (config.news?.sources ?? []).map((src, index) => ({ src, index })).filter(({ src }) => src.enabled !== false);
    for (const { src, index } of sources) {
      try {
        out.push(...(await fetchSource(src, index, context)));
      } catch (e) {
        if (isCancellation(e)) throw e;
        const corsHint = e.name === "TypeError" || /Failed to fetch/i.test(e.message)
          ? " (ブラウザのCORS制限の可能性があります。news.corsProxy の設定を検討してください)"
          : "";
        log(`ニュース取得失敗 [${src.name}]: ${e.message}${corsHint}`, "error");
      }
    }
    return refineItems(out);
  }

  function resolvePersona() {
    const news = getConfig().news ?? {};
    return (news.persona && personaRouter.get(news.persona)) || personaRouter.defaultPersona();
  }

  function resolveConnector(persona) {
    try {
      const connector = getConnector(persona.connector);
      if (connector?.chat) return connector;
      log(`ニュース担当ペルソナ「${persona.name}」の connector が未設定です。item は未読のままです`, "error");
    } catch (error) {
      log(`ニュース担当 connector を初期化できません: ${error.message}。item は未読のままです`, "error");
    }
    return null;
  }

  function canDeliver() {
    return typeof speechQueue?.enqueue === "function";
  }

  async function generate({ persona, item, connector, requestId, context }) {
    const { messages, debugText } = contextBuilder.build({ persona, news: item, includeScreen: "never" });
    const result = await connector.chat(messages, { signal: context.signal, requestId, generation: context.generation });
    const { text } = result;
    if (!String(text ?? "").trim()) throw Object.assign(new Error("ニュース要約が空です"), { kind: "empty" });
    guardPipelineContext(context);
    if (isOutputLimitFinishReason(result.finishReason)) log(buildOutputLimitWarning(result.finishReason, persona.connector), "warn");
    return { text, debugText, finishReason: result.finishReason };
  }

  function deliver({ persona, item, text }) {
    const queued = speechQueue.enqueue({ personaId: persona.id, personaName: persona.name, text, voice: persona.voice, source: "news" });
    if (queued?.state === "dropped") log(`ニュース音声はキュー上限で破棄されました [${item.title}]`, "warn");
    return { queued };
  }

  return { fetchAll, fetchSource, refineItems, resolvePersona, resolveConnector, canDeliver, generate, deliver };
}
