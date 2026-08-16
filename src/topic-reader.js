// 話題リーダー
// Todoistなどの「配信ネタ」ソースから話題を取得し、AIコメントとして読み上げキューに入れる。

import { cancelElectronTopicRequest, completeTopicThroughElectron, fetchTopicsThroughElectron, hasElectronTopicService } from "./platform/electron-services.js";
import { RequestCancelledError, isCancellation } from "./runtime/request-registry.js";
import { MemoryItemProcessingStore } from "./readers/item-processing-store.js";
import { createReaderItemKey, readerStatus, retryOptions } from "./readers/reader-runner.js";
import { retryDecision } from "./readers/retry-policy.js";
import { buildOutputLimitWarning, isOutputLimitFinishReason } from "./ai-finish-reason.js";
import { resolvePersona } from "./personas/persona-selection-policy.js";
import { deriveIdentityKeys } from "./news/selection/dedupe-candidates.js";
import { MemoryNewsHistoryStore } from "./news/selection/memory-news-history-store.js";
import { NEWS_HISTORY_DEFAULTS } from "./news/selection/news-history-store.js";

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
  constructor({ config, getConnector, personaRouter, contextBuilder, speechQueue, webResearcher = null, log = () => {}, onRead = () => {}, store = new MemoryItemProcessingStore(), historyStore = null, clock = () => Date.now(), random = Math.random, isRuntimeEnabled = () => true }) {
    this.config = config;
    this.getConnector = getConnector;
    this.personaRouter = personaRouter;
    this.contextBuilder = contextBuilder;
    this.speechQueue = speechQueue;
    this.webResearcher = webResearcher;
    this.log = log;
    this.onRead = onRead;
    this.store = store;
    this.clock = clock;
    // issue #278: タイトル単位の重複排除履歴 (news と同じ契約)。既定はbounded memory実装で、
    // runtime-factory経由ではboot.jsの単一インスタンス (deps.topicHistoryStore) が渡され、
    // config reload をまたいで生存する。fake clockテストのために this.clock と同期する。
    this.historyStore = historyStore ?? new MemoryNewsHistoryStore({ clock: this.clock });
    this.random = random;
    this.isRuntimeEnabled = isRuntimeEnabled;
    this.generation = 0;
    this.busy = false;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastRunResult = null;
  }

  get readGuids() {
    return new Set(this.store.list({ states: "read" }).map((record) => record.guid ?? record.key));
  }

  // config.topics.enabled (設定保存が必要) と、操作卓のトグル (config.local.jsonではなく
  // localStorageへ即時反映・再起動後も前回値を保持する自動発火の一時停止スイッチ、
  // src/ui/reader-toggle-preferences.js参照) の両方が立っているときだけ有効。
  get enabled() {
    return !!this.config.topics?.enabled && this.isRuntimeEnabled();
  }

  async run(context = {}) {
    const topics = this.config.topics;
    if (!topics?.enabled) {
      this.log("話題機能は無効です (topics.enabled: false)");
      return;
    }
    // context.manual (操作卓の「生成して貯める」「再生」ボタン由来) のときだけ自動読み上げ
    // トグルをバイパスする。上のtopics.enabledガードは手動でも無条件のまま。
    if (!context.manual && !this.isRuntimeEnabled()) {
      this.log("話題機能は操作卓のトグルで一時停止中です");
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
      // issue #278: タイトル単位のdedupeを slice() より前で行う。maxItems: 1 (buffered path)
      // のときに履歴で弾かれた項目が枠を消費して、後ろの有効な候補が読まれなくなる事故を避ける。
      const maxItems = context.maxItems ?? topics.maxItems ?? 3;
      const picks = [];
      for (const item of items) {
        if (!candidateKeys.has(item.processingKey)) continue;
        if (this.#isHistoryDuplicate(item, now)) {
          this.log(`話題の重複 (以前に読み上げ済み) のためスキップします [${item.title}]`, "warn");
          continue;
        }
        picks.push(item);
        if (picks.length >= maxItems) break;
      }
      this.lastRunResult = { candidates: candidateKeys.size, processed: 0, succeeded: 0, retryScheduled: 0, failed: 0 };
      this.log(`話題候補 ${items.length}件 (再処理可能 ${candidateKeys.size}件、読み上げ ${picks.length}件)`);
      if (!picks.length) return;

      if (!this.#hasUsablePersonaConfig(topics)) throw new Error("話題読み上げに使えるペルソナがありません");
      if (typeof this.speechQueue?.enqueue !== "function") {
        this.log("話題音声キューが利用できません。item は未読のままです", "error");
        return;
      }

      for (const item of picks) {
        this.#guard(context);
        const persona = this.#resolvePersona(topics);
        if (!persona || persona.enabled === false) {
          if (persona) this.log(`話題担当ペルソナ「${persona.name}」が無効化中のためスキップしました`);
          continue;
        }
        const connector = this.#getConnector(persona);
        if (!connector) continue;
        const record = this.store.begin(item.processingKey, this.generation, this.clock());
        if (!record) continue;
        this.lastRunResult.processed++;
        try {
          const research = await this.#research(item, context);
          const { messages, debugText } = this.contextBuilder.build({ persona, topic: item, research, includeScreen: "never" });
          const result = await connector.chat(messages, { signal: context.signal, requestId: `${context.requestId ?? "topics"}:summary:${item.guid}`, generation: context.generation });
          const { text } = result;
          if (!String(text ?? "").trim()) throw Object.assign(new Error("話題コメントが空です"), { kind: "empty" });
          this.#guard(context);
          if (isOutputLimitFinishReason(result.finishReason)) this.log(buildOutputLimitWarning(result.finishReason, persona.connector), "warn");
          this.#guard(context);
          // onDelivered fires once this reaches the REAL speech queue, never merely on
          // pregenerated-buffer acceptance (see GeneratedSpeechBuffer / SpeechQueue.enqueue()) —
          // otherwise the console/overlay "last read" broadcast and the Todoist task completion
          // (an external side effect) would both fire for an item that may never be spoken.
          // completeTodoistTask is detached (not awaited): it self-logs everything except a
          // cancellation, which it rethrows — catch that here instead of an unhandled rejection.
          // deliveryPayload mirrors onDelivered's onRead data as plain data (see the equivalent
          // news-pipeline-coordinator.js comment) so GeneratedSpeechBuffer can rebind both this
          // and the Todoist completion to the CURRENT generation after a config reload, instead
          // of replaying this specific run's (possibly stale) closure.
          const deliveryPayload = { persona, item, text, debugText };
          // preserve: 話題提供はコメント・AI応答と同様、マイク発話による保留 (hold("mic"))
          // やキュー上限・期限切れで自動破棄しない (issue #284)。マイクで話している間も
          // 待機し続け、無音に戻ったら確実に読み上げられる。
          const queued = this.speechQueue.enqueue({ personaId: persona.id, personaName: persona.name, text, voice: persona.voice, source: "topics", preserve: true, onDelivered: () => { this.onRead(deliveryPayload); this.completeTodoistTask(item, context).catch((error) => { if (!isCancellation(error)) this.log(`Todoistタスクの完了処理に失敗しました [${item.title}]: ${error.message}`, "warn"); }); }, deliveryPayload });
          this.#guard(context);
          // onDelivered (onRead + Todoist completion) only fires when queued.state !== "dropped"
          // (SpeechQueue.enqueue()'s own contract), so a drop must not markRead either — that
          // would permanently hide an item that was never actually spoken and whose Todoist task
          // was never closed. Reset it back to unread instead so a later run can retry it.
          if (queued?.state === "dropped") {
            this.log(`話題音声はキュー上限で破棄されました [${item.title}]`, "warn");
            this.store.resetUnread(item.processingKey, this.generation, this.clock());
            continue;
          }
          // commit(markRead)成功時にだけ履歴へ記録する (issue #278)。markReadが失敗するのは
          // 通常の流れでは起こらないが (stateがprocessing以外になった場合など)、記録だけ先に
          // 進んで未読のまま30日間重複排除されるのを防ぐため、成功時だけを契約にする。
          const committed = this.store.markRead(item.processingKey, this.generation, this.clock());
          if (committed) {
            const deliveredKeys = deriveIdentityKeys(item);
            this.historyStore.recordDelivered({ candidateId: item.processingKey, titleKey: deliveredKeys.titleKey, topicKey: deliveredKeys.topicKey, urlHash: deliveredKeys.urlHash, sourceId: item.sourceName ?? "unknown" }, this.clock());
            this.lastRunResult.succeeded++;
            this.lastSuccessAt = new Date(this.clock());
          }
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
        if (String(e?.kind ?? "").toLowerCase() === "auth") {
          this.log(`話題取得の認証に失敗しました [${src.name}]: トークンが無効か期限切れの可能性があります。設定でTodoist個人アクセストークンを再設定してください (${e.message})`, "error");
          continue;
        }
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
          throw Object.assign(new Error(result?.error?.message ?? "Main processから話題を取得できませんでした"), result?.error?.code === "AUTH" ? { kind: "auth" } : {});
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
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} (Todoist token/projectIdを確認してください)`), (res.status === 401 || res.status === 403) ? { kind: "auth" } : {});
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
    const keptKeys = new Map();
    const refined = [];
    for (const item of items) {
      const key = normalizeTitle(item.title);
      if (topics.dedupe !== false && key) {
        if (seen.has(key)) {
          // issue #278: 同一バッチ内の重複タイトルはバッチから外すだけでなく、ストア上でも
          // skipped にしておく — 別タスクID (guid) で再登録された重複が、後のrunで再び
          // 候補にならないようにする。ただし最初に採用した項目と同じキー (同一タスクが
          // 別ソースから二度取得された場合) のときは、採用済み項目をskippedへ上書きして
          // 読まれなくならないよう、ensure+skip しない。
          const duplicateKey = createReaderItemKey(item, "topics");
          if (duplicateKey !== keptKeys.get(key)) {
            this.store.ensure({ ...item, key: duplicateKey }, this.generation, this.clock());
            this.store.skip(duplicateKey, this.generation, this.clock());
          }
          continue;
        }
        seen.add(key);
      }
      const processingKey = createReaderItemKey(item, "topics");
      keptKeys.set(key, processingKey);
      refined.push({ ...item, normalizedTitle: key, processingKey });
    }
    refined.sort((a, b) => {
      const bt = Date.parse(b.publishedAt ?? "") || 0;
      const at = Date.parse(a.publishedAt ?? "") || 0;
      return bt - at;
    });
    return refined;
  }

  // issue #278: タイトル単位の重複排除。news の filterCandidates と同じ契約
  // (hasDeliveredTitle: 永続 / hasRecentTopic: 24h cooldown) を使う。
  // guid (タスクID) が変わっても同じ話題なら二度読まない。
  #isHistoryDuplicate(item, now) {
    const topics = this.config.topics ?? {};
    if (topics.dedupe === false) return false;
    const { titleKey, topicKey } = deriveIdentityKeys(item);
    if (!titleKey) return false;
    if (this.historyStore.hasDeliveredTitle(titleKey)) return true;
    if (topicKey && this.historyStore.hasRecentTopic(topicKey, now, NEWS_HISTORY_DEFAULTS.topicCooldownHours * 60 * 60 * 1000)) return true;
    return false;
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

  // 話題読み上げの依頼文（タイトル+メモ）をクエリにWeb調査prepassを実行する。ResponseCoordinatorと
  // 同じ「検索失敗時は検索なしの通常回答へフォールバック」方針で、cancellationだけ再送出する。
  async #research(item, context) {
    if (!this.webResearcher?.enabled) return null;
    const task = [item.title, item.description].filter(Boolean).join("\n");
    try {
      const research = await this.webResearcher.research({ task, signal: context.signal, requestId: `${context.requestId ?? "topics"}:research:${item.guid}`, generation: context.generation });
      this.#guard(context);
      return research;
    } catch (error) {
      if (isCancellation(error) || context.signal?.aborted) throw error;
      this.log(`話題のWeb調査prepassに失敗しました [${item.title}]: ${error.message}`, "warn");
      return null;
    }
  }

  // 実行前の設定不備チェック用。乱数は消費せず「そもそも解決しうるペルソナ設定があるか」だけを見る
  // (有効/無効の判定はitemごとの#resolvePersonaに任せる)。
  #hasUsablePersonaConfig(topics) {
    return !!resolvePersona({
      fixedPersonaId: topics.persona,
      randomEnabled: topics.randomPersona,
      candidatePersonaIds: topics.personas,
      personaRouter: this.personaRouter,
      random: () => 0,
    });
  }

  // topics.randomPersona が有効な場合、topics.personas (有効なものだけ) から毎item抽選する。
  // これにより同じ実行内でも話題ごとに担当ペルソナが変わりうる。無効時/候補が尽きた場合は
  // 従来通り topics.persona → router.defaultPersona の順にフォールバックする。
  #resolvePersona(topics) {
    return resolvePersona({
      fixedPersonaId: topics.persona,
      randomEnabled: topics.randomPersona,
      candidatePersonaIds: topics.personas,
      personaRouter: this.personaRouter,
      random: this.random,
    });
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
