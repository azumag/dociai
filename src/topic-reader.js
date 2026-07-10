// 話題リーダー
// Todoistなどの「配信ネタ」ソースから話題を取得し、AIコメントとして読み上げキューに入れる。

import { cancelElectronTopicRequest, completeTopicThroughElectron, fetchTopicsThroughElectron, hasElectronTopicService } from "./platform/electron-services.js";
import { RequestCancelledError, isCancellation } from "./runtime/request-registry.js";

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

export class TopicReader {
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
    return !!this.config.topics?.enabled;
  }

  async run(context = {}) {
    const topics = this.config.topics;
    if (!topics?.enabled) {
      this.log("話題機能は無効です (topics.enabled: false)");
      return;
    }
    if (this.busy) {
      this.log("話題処理が進行中のためスキップしました");
      return;
    }
    this.busy = true;
    this.lastRunAt = new Date();
    try {
      this.#guard(context);
      const items = await this.fetchAll(context);
      const unread = items.filter((i) => !this.readGuids.has(i.guid));
      const picks = unread.slice(0, topics.maxItems ?? 3);
      this.log(`話題候補 ${items.length}件 (未読 ${unread.length}件、読み上げ ${picks.length}件)`);
      if (!picks.length) return;

      const persona = (topics.persona && this.personaRouter.get(topics.persona)) || this.personaRouter.defaultPersona();
      if (!persona) throw new Error("話題読み上げに使えるペルソナがありません");
      if (!persona.enabled) {
        this.log(`話題担当ペルソナ「${persona.name}」が無効化中のためスキップしました`);
        return;
      }
      const connector = this.getConnector(persona.connector);

      for (const item of picks) {
        this.#guard(context);
        const { messages, debugText } = this.contextBuilder.build({ persona, topic: item, includeScreen: "never" });
        try {
          const { text } = await connector.chat(messages, { signal: context.signal, requestId: `${context.requestId ?? "topics"}:summary:${item.guid}`, generation: context.generation });
          this.#guard(context);
          this.readGuids.add(item.guid);
          this.#guard(context);
          this.onRead({ persona, item, text, debugText });
          this.#guard(context);
          this.speechQueue.enqueue({ personaId: persona.id, personaName: persona.name, text, voice: persona.voice });
          await this.completeTodoistTask(item, context);
        } catch (e) {
          if (isCancellation(e)) throw e;
          this.log(`話題1件の読み上げ失敗 [${item.title}]: ${e.message}`, "error");
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async fetchAll(context = {}) {
    const out = [];
    const sources = (this.config.topics?.sources ?? []).map((src, index) => ({ src, index })).filter(({ src }) => src.enabled !== false);
    for (const { src, index } of sources) {
      try {
        out.push(...(await this.fetchSource(src, index, context)));
      } catch (e) {
        if (isCancellation(e)) throw e;
        this.log(`話題取得失敗 [${src.name}]: ${e.message}`, "error");
      }
    }
    return this.refineItems(out);
  }

  async fetchSource(src, sourceIndex, context = {}) {
    if (src.type === "todoist") {
      if (hasElectronTopicService()) {
        const requestId = `${context.requestId ?? "topics"}:fetch:${sourceIndex}`;
        const cancel = () => { void cancelElectronTopicRequest(requestId); };
        context.signal?.addEventListener("abort", cancel, { once: true });
        const result = await fetchTopicsThroughElectron({ sourceIndex, requestId, ownerId: "console" }).finally(() => context.signal?.removeEventListener("abort", cancel));
        if (!result?.ok) {
          if (result?.error?.code === "CANCELLED") throw new RequestCancelledError();
          throw new Error(result?.error?.message ?? "Main processから話題を取得できませんでした");
        }
        this.#guard(context);
        return result.value.items;
      }
      return this.fetchTodoist(src, sourceIndex, context);
    }
    throw new Error(`未対応の話題ソース種別 "${src.type}"`);
  }

  // Todoist API v1 は project_id クエリでの絞り込みに完全に依存せず、
  // 念のためレスポンス側でも project_id を突き合わせて絞り込む。
  async fetchTodoist(src, sourceIndex, context = {}) {
    const res = await fetch(`https://api.todoist.com/api/v1/tasks?project_id=${encodeURIComponent(src.projectId)}`, {
      headers: { Authorization: `Bearer ${src.token}` }, signal: context.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} (Todoist token/projectIdを確認してください)`);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.results ?? []);
    const tasks = rows.filter((t) => String(t.project_id) === String(src.projectId));
    return tasks.map((t) => ({
      title: t.content,
      description: t.description ?? "",
      publishedAt: parseDate(t.created_at ?? t.createdAt),
      guid: `todoist:${t.id}`,
      sourceName: src.name,
      kind: "topic",
      _todoistToken: src.token,
      _todoistTaskId: t.id,
      _sourceIndex: sourceIndex,
    })).filter((t) => t.title);
  }

  // 読み上げに使えた話題だけ Todoist 側でも完了にする。
  async completeTodoistTask(item, context = {}) {
    if (!item._todoistTaskId && !item.taskId) return;
    try {
      if (hasElectronTopicService()) {
        const requestId = `${context.requestId ?? "topics"}:complete:${item.taskId ?? item._todoistTaskId}`;
        const cancel = () => { void cancelElectronTopicRequest(requestId); };
        context.signal?.addEventListener("abort", cancel, { once: true });
        const result = await completeTopicThroughElectron({ sourceIndex: item.sourceIndex ?? item._sourceIndex, taskId: String(item.taskId ?? item._todoistTaskId), requestId, ownerId: "console" }).finally(() => context.signal?.removeEventListener("abort", cancel));
        if (!result?.ok) {
          if (result?.error?.code === "CANCELLED") throw new RequestCancelledError();
          throw new Error(result?.error?.message ?? "Main processでTodoistタスクを完了できませんでした");
        }
        this.#guard(context);
        return;
      }
      const res = await fetch(`https://api.todoist.com/api/v1/tasks/${encodeURIComponent(item._todoistTaskId)}/close`, {
        method: "POST",
        headers: { Authorization: `Bearer ${item._todoistToken}` }, signal: context.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (isCancellation(e)) throw e;
      this.log(`Todoistタスクの完了処理に失敗しました [${item.title}]: ${e.message}`, "warn");
    }
  }

  refineItems(items) {
    const topics = this.config.topics ?? {};
    const seen = new Set();
    const refined = [];
    for (const item of items) {
      const key = normalizeTitle(item.title);
      if (topics.dedupe !== false && key) {
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
    if (context.isCurrent && !context.isCurrent()) throw new RequestCancelledError("話題処理は設定変更で停止しました", "stale-generation");
  }
}
