// 話題リーダー
// Todoistなどの「配信ネタ」ソースから話題を取得し、AIコメントとして読み上げキューに入れる。

import { cancelElectronTopicRequest, completeTopicThroughElectron, fetchTopicsThroughElectron, hasElectronTopicService } from "./platform/electron-services.js";
import { RequestCancelledError, isCancellation } from "./runtime/request-registry.js";
import { MemoryItemProcessingStore } from "./readers/item-processing-store.js";
import { createReaderItemKey, readerStatus, retryOptions } from "./readers/reader-runner.js";
import { retryDecision } from "./readers/retry-policy.js";
import { buildOutputLimitWarning, isOutputLimitFinishReason } from "./ai-finish-reason.js";

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
  constructor({ config, getConnector, personaRouter, contextBuilder, speechQueue, log = () => {}, onRead = () => {}, store = new MemoryItemProcessingStore(), clock = () => Date.now() }) {
    this.config = config;
    this.getConnector = getConnector;
    this.personaRouter = personaRouter;
    this.contextBuilder = contextBuilder;
    this.speechQueue = speechQueue;
    this.log = log;
    this.onRead = onRead;
    this.store = store;
    this.clock = clock;
    this.generation = 0;
    this.busy = false;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastRunResult = null;
  }

  get readGuids() {
    return new Set(this.store.list({ states: "read" }).map((record) => record.guid ?? record.key));
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
    this.generation = context.generation ?? this.generation;
    this.busy = true;
    this.lastRunAt = new Date(this.clock());
    try {
      this.#guard(context);
      const items = await this.fetchAll(context);
      const now = this.clock();
      for (const item of items) this.store.ensure({ ...item, key: item.processingKey }, this.generation, now);
      const candidateKeys = new Set(this.store.candidates(this.generation, now).map((record) => record.key));
      const picks = items.filter((item) => candidateKeys.has(item.processingKey)).slice(0, topics.maxItems ?? 3);
      this.lastRunResult = { candidates: candidateKeys.size, processed: 0, succeeded: 0, retryScheduled: 0, failed: 0 };
      this.log(`話題候補 ${items.length}件 (再処理可能 ${candidateKeys.size}件、読み上げ ${picks.length}件)`);
      if (!picks.length) return;

      const persona = (topics.persona && this.personaRouter.get(topics.persona)) || this.personaRouter.defaultPersona();
      if (!persona) throw new Error("話題読み上げに使えるペルソナがありません");
      if (!persona.enabled) {
        this.log(`話題担当ペルソナ「${persona.name}」が無効化中のためスキップしました`);
        return;
      }
      const connector = this.#getConnector(persona);
      if (!connector) return;
      if (typeof this.speechQueue?.enqueue !== "function") {
        this.log("話題音声キューが利用できません。item は未読のままです", "error");
        return;
      }

      for (const item of picks) {
        this.#guard(context);
        const record = this.store.begin(item.processingKey, this.generation, this.clock());
        if (!record) continue;
        this.lastRunResult.processed++;
        try {
          const { messages, debugText } = this.contextBuilder.build({ persona, topic: item, includeScreen: "never" });
          const result = await connector.chat(messages, { signal: context.signal, requestId: `${context.requestId ?? "topics"}:summary:${item.guid}`, generation: context.generation });
          const { text } = result;
          if (!String(text ?? "").trim()) throw Object.assign(new Error("話題コメントが空です"), { kind: "empty" });
          this.#guard(context);
          if (isOutputLimitFinishReason(result.finishReason)) this.log(buildOutputLimitWarning(result.finishReason, persona.connector), "warn");
          this.onRead({ persona, item, text, debugText });
          this.#guard(context);
          const queued = this.speechQueue.enqueue({ personaId: persona.id, personaName: persona.name, text, voice: persona.voice, source: "topics" });
          if (queued?.state === "dropped") this.log(`話題音声はキュー上限で破棄されました [${item.title}]`, "warn");
          await this.completeTodoistTask(item, context);
          this.#guard(context);
          this.store.markRead(item.processingKey, this.generation, this.clock());
          this.lastRunResult.succeeded++;
          this.lastSuccessAt = new Date(this.clock());
        } catch (e) {
          if (isCancellation(e)) {
            this.store.resetUnread(item.processingKey, this.generation, this.clock());
            throw e;
          }
          if (String(e?.kind ?? "").toLowerCase() === "auth") {
            this.store.resetUnread(item.processingKey, this.generation, this.clock());
            this.log("話題要約の認証に失敗しました。connector 設定を確認してから再実行してください", "error");
            return;
          }
          const decision = retryDecision(e, { attempts: record.attempts, now: this.clock(), ...retryOptions(topics) });
          this.store.markFailure(item.processingKey, this.generation, e, decision, this.clock());
          if (decision.action === "retry") this.lastRunResult.retryScheduled++;
          else this.lastRunResult.failed++;
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
      refined.push({ ...item, normalizedTitle: key, processingKey: createReaderItemKey(item, "topics") });
    }
    refined.sort((a, b) => {
      const bt = Date.parse(b.publishedAt ?? "") || 0;
      const at = Date.parse(a.publishedAt ?? "") || 0;
      return bt - at;
    });
    return refined;
  }

  status() {
    return { ...readerStatus(this.store, this.enabled, this.busy, this.lastRunAt), lastSuccessAt: this.lastSuccessAt, lastRunResult: this.lastRunResult };
  }

  retryNow(key) {
    return this.store.retryNow(key, this.generation, this.clock());
  }

  skip(key) {
    return this.store.skip(key, this.generation, this.clock());
  }

  restore(key) {
    return this.store.restore(key, this.generation, this.clock());
  }

  #getConnector(persona) {
    try {
      const connector = this.getConnector(persona.connector);
      if (connector?.chat) return connector;
      this.log(`話題担当ペルソナ「${persona.name}」の connector が未設定です。item は未読のままです`, "error");
    } catch (error) {
      this.log(`話題担当 connector を初期化できません: ${error.message}。item は未読のままです`, "error");
    }
    return null;
  }

  #guard(context) {
    if (context.signal?.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new RequestCancelledError();
    if (context.isCurrent && !context.isCurrent()) throw new RequestCancelledError("話題処理は設定変更で停止しました", "stale-generation");
  }
}
