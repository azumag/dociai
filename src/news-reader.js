// ニュースリーダー (issue #10, #187)
// 互換facade: 実処理は src/news/news-pipeline-coordinator.js (NewsPipelineCoordinator) へ
// 委譲する。外部から見えるAPI (constructor引数・run/fetchAll/refineItems/status/retryNow/
// skip/restore/readGuids/enabled) は変更しない — 既読はProcessingStoreが唯一の正本。
import { MemoryItemProcessingStore } from "./readers/item-processing-store.js";
import { createNewsPipelineCoordinator } from "./news/news-pipeline-coordinator.js";

export class NewsReader {
  constructor({ config, getConnector, personaRouter, contextBuilder, speechQueue, log = () => {}, onRead = () => {}, store = new MemoryItemProcessingStore(), clock = () => Date.now(), pipeline = null }) {
    this.config = config;
    this.getConnector = getConnector;
    this.personaRouter = personaRouter;
    this.contextBuilder = contextBuilder;
    this.speechQueue = speechQueue;
    this.log = log;
    this.onRead = onRead;
    this.store = store;
    this.clock = clock;
    // pipelineが注入されない場合 (直接構築されるテスト/簡易利用) は、自分自身の`fetchAll`へ
    // 委譲するacquire stageを持つcoordinatorを内部構築する。これにより `reader.fetchAll = ...`
    // による差し替えが、run() 経由でも引き続き効く。
    this.pipeline = pipeline ?? createNewsPipelineCoordinator({
      getConfig: () => this.config,
      getConnector: (id) => this.getConnector(id),
      personaRouter: this.personaRouter,
      contextBuilder: this.contextBuilder,
      speechQueue: this.speechQueue,
      log: (...args) => this.log(...args),
      onRead: (...args) => this.onRead(...args),
      store: this.store,
      clock: this.clock,
      fetchAll: (context) => this.fetchAll(context),
    });
  }

  // 従来の外部利用との互換性。内部状態の唯一の正本は processing store。
  get readGuids() {
    return new Set(this.store.list({ states: "read" }).map((record) => record.guid ?? record.key));
  }

  get enabled() {
    return !!this.config.news?.enabled;
  }

  // トリガー (interval/manual) から呼ばれるエントリポイント
  async run(context = {}) {
    return this.pipeline.run(context);
  }

  async fetchAll(context = {}) {
    return this.pipeline.fetchAll(context);
  }

  refineItems(items) {
    return this.pipeline.refineItems(items);
  }

  status() {
    return this.pipeline.status();
  }

  retryNow(key) {
    return this.pipeline.retryNow(key);
  }

  skip(key) {
    return this.pipeline.skip(key);
  }

  restore(key) {
    return this.pipeline.restore(key);
  }
}
