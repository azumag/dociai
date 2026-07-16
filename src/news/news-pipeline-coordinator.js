// NewsPipelineCoordinator (issue #187)
// acquire -> select -> [researching -> generating -> validating(+rewriting) -> delivering] を
// candidateごとに実行し、commit(ItemProcessingStore.markRead)はdelivery成功後にだけ行う。
// stageは例外を握り潰さず、coordinatorだけがretry/skip/commit/UI通知を決定する
// (issue #186 Pipeline contract)。
//
// 排他責務: このcoordinatorの`busy`は「同一instanceへの再入」だけを防ぐ。kind単位の排他は
// src/app/automation-coordinator.js の役目であり、二重化しない (issue #187 Runtime wiring)。

import { MemoryItemProcessingStore } from "../readers/item-processing-store.js";
import { readerStatus, retryOptions } from "../readers/reader-runner.js";
import { retryDecision } from "../readers/retry-policy.js";
import { isCancellation } from "../runtime/request-registry.js";
import { PIPELINE_STATUS, PipelineStageError, emptyDiagnostics, guardPipelineContext, normalizeStageError } from "./contracts.js";
import { resolveModePolicy } from "./mode-policy.js";
import { createLegacyNewsAdapter } from "./adapters/legacy-news-adapter.js";
import { createAcquireStage } from "./stages/acquire-stage.js";
import { createSelectStage } from "./stages/select-stage.js";
import { createResearchStage } from "./stages/research-stage.js";
import { createGenerateStage } from "./stages/generate-stage.js";
import { createQualityStage } from "./stages/quality-stage.js";
import { createDeliverStage } from "./stages/deliver-stage.js";

export class NewsPipelineCoordinator {
  constructor({ getConfig, adapter, stages, store = new MemoryItemProcessingStore(), clock = () => Date.now(), log = () => {}, onRead = () => {}, maxRewrites = 1 }) {
    this.getConfig = getConfig;
    this.adapter = adapter;
    this.stages = stages;
    this.store = store;
    this.clock = clock;
    this.log = log;
    this.onRead = onRead;
    this.maxRewrites = maxRewrites;
    this.generation = 0;
    this.busy = false;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastRunResult = null;
  }

  async fetchAll(context = {}) {
    return this.adapter.fetchAll(context);
  }

  refineItems(items) {
    return this.adapter.refineItems(items);
  }

  async run(context = {}) {
    const config = this.getConfig();
    const news = config.news ?? {};
    if (!news.enabled) {
      this.log("ニュース機能は無効です (news.enabled: false)");
      return { status: PIPELINE_STATUS.SKIPPED, diagnostics: emptyDiagnostics({ mode: news.mode }) };
    }
    if (this.busy) {
      this.log("ニュース処理が進行中のためスキップしました");
      return { status: PIPELINE_STATUS.SKIPPED, diagnostics: emptyDiagnostics({ mode: news.mode }) };
    }
    this.generation = context.generation ?? this.generation;
    this.busy = true;
    this.lastRunAt = new Date(this.clock());
    const diagnostics = emptyDiagnostics({ runId: context.requestId ?? null, mode: news.mode ?? "topic" });
    try {
      guardPipelineContext(context);
      const items = await this.stages.acquire.run(null, context);
      diagnostics.candidateCounts.acquired = items.length;

      const { picks, eligibleCount } = await this.stages.select.run({ items, generation: this.generation, maxItems: news.maxItems ?? 3 }, context);
      diagnostics.candidateCounts.filtered = eligibleCount;
      diagnostics.candidateCounts.eligible = picks.length;
      this.lastRunResult = { candidates: eligibleCount, processed: 0, succeeded: 0, retryScheduled: 0, failed: 0 };
      this.log(`ニュース候補 ${items.length}件 (再処理可能 ${eligibleCount}件、読み上げ ${picks.length}件)`);
      if (!picks.length) return { status: PIPELINE_STATUS.NO_CANDIDATE, diagnostics };

      const persona = this.adapter.resolvePersona();
      if (!persona) throw new Error("ニュース読み上げに使えるペルソナがありません");
      if (!persona.enabled) {
        this.log(`ニュース担当ペルソナ「${persona.name}」が無効化中のためスキップしました`);
        return { status: PIPELINE_STATUS.SKIPPED, diagnostics };
      }
      const connector = this.adapter.resolveConnector(persona);
      if (!connector) return { status: PIPELINE_STATUS.FAILED, stage: "generate", diagnostics };
      if (!this.adapter.canDeliver()) {
        this.log("ニュース音声キューが利用できません。item は未読のままです", "error");
        return { status: PIPELINE_STATUS.FAILED, stage: "deliver", diagnostics };
      }

      const modePolicy = resolveModePolicy(news.mode, news.modeOverrides);
      let lastCandidateId = null;
      for (const item of picks) {
        guardPipelineContext(context);
        const record = this.store.begin(item.processingKey, this.generation, this.clock());
        if (!record) continue;
        lastCandidateId = item.processingKey;
        this.lastRunResult.processed++;
        try {
          const requestId = `${context.requestId ?? "news"}:summary:${item.guid}`;
          const research = await this.stages.research.run({ item, persona, modePolicy }, context);
          let generated = await this.stages.generate.run({ item, persona, connector, research, requestId }, context);
          guardPipelineContext(context);
          let quality = await this.stages.quality.run({ text: generated.text, item, modePolicy }, context);
          let rewriteCount = 0;
          while (!quality.passed && rewriteCount < this.maxRewrites) {
            rewriteCount++;
            diagnostics.rewriteCount++;
            diagnostics.fallbackPath.push(`rewrite:${rewriteCount}`);
            generated = await this.stages.generate.run({ item, persona, connector, research, requestId: `${requestId}:rewrite:${rewriteCount}`, feedback: quality.reasons }, context);
            guardPipelineContext(context);
            quality = await this.stages.quality.run({ text: generated.text, item, modePolicy }, context);
          }
          if (!quality.passed) throw new PipelineStageError("ニュース品質検査に失敗しました", { stage: "quality", kind: "quality_failed" });

          this.onRead({ persona, item, text: generated.text, debugText: generated.debugText });
          guardPipelineContext(context);
          await this.stages.deliver.run({ persona, item, text: generated.text }, context);
          guardPipelineContext(context);
          this.store.markRead(item.processingKey, this.generation, this.clock());
          this.lastRunResult.succeeded++;
          this.lastSuccessAt = new Date(this.clock());
          diagnostics.sourceIds.push(item.sourceName ?? "unknown");
        } catch (e) {
          if (isCancellation(e)) {
            this.store.resetUnread(item.processingKey, this.generation, this.clock());
            throw e;
          }
          if (String(e?.kind ?? "").toLowerCase() === "auth") {
            this.store.resetUnread(item.processingKey, this.generation, this.clock());
            this.log("ニュース要約の認証に失敗しました。connector 設定を確認してから再実行してください", "error");
            diagnostics.errorCode = "auth";
            return { status: PIPELINE_STATUS.FAILED, stage: "generate", candidateId: item.processingKey, diagnostics };
          }
          const decision = retryDecision(e, { attempts: record.attempts, now: this.clock(), ...retryOptions(news) });
          this.store.markFailure(item.processingKey, this.generation, e, decision, this.clock());
          if (decision.action === "retry") this.lastRunResult.retryScheduled++;
          else this.lastRunResult.failed++;
          this.log(`ニュース1件の読み上げ失敗 [${item.title}]: ${e.message}`, "error");
          diagnostics.errorCode = normalizeStageError(e, "generate").kind;
        }
      }
      return { status: PIPELINE_STATUS.DELIVERED, candidateId: lastCandidateId, diagnostics };
    } finally {
      this.busy = false;
    }
  }

  status() {
    const config = this.getConfig();
    return { ...readerStatus(this.store, Boolean(config.news?.enabled), this.busy, this.lastRunAt), lastSuccessAt: this.lastSuccessAt, lastRunResult: this.lastRunResult };
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
}

// legacy adapter配線込みの既定coordinatorを組み立てる。fetchAllを渡すと acquire stage が
// それを使う (NewsReaderファサードが自分自身の`fetchAll`へ委譲することで、既存テストの
// `reader.fetchAll = ...` という差し替えを引き続き効かせるため)。省略時は
// adapter.fetchAllをそのまま使う。
export function createNewsPipelineCoordinator({
  getConfig,
  getConnector,
  personaRouter,
  contextBuilder,
  speechQueue,
  log = () => {},
  onRead = () => {},
  store = new MemoryItemProcessingStore(),
  clock = () => Date.now(),
  fetchAll: fetchAllOverride,
  stages: stageOverrides = {},
  maxRewrites = 1,
}) {
  const adapter = createLegacyNewsAdapter({ getConfig, getConnector, personaRouter, contextBuilder, speechQueue, log });
  const stages = {
    acquire: stageOverrides.acquire ?? createAcquireStage({ fetchAll: fetchAllOverride ?? adapter.fetchAll }),
    select: stageOverrides.select ?? createSelectStage({ store, clock }),
    research: stageOverrides.research ?? createResearchStage(),
    generate: stageOverrides.generate ?? createGenerateStage({ adapter }),
    quality: stageOverrides.quality ?? createQualityStage(),
    deliver: stageOverrides.deliver ?? createDeliverStage({ adapter }),
  };
  return new NewsPipelineCoordinator({ getConfig, adapter, stages, store, clock, log, onRead, maxRewrites });
}
