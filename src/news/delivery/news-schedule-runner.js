// NewsScheduleRunner (issue #193): config.news.scheduleの時刻slotを定期pollし、
// resolveDueSlot() (news-schedule-policy.js) で発火判定してAutomationCoordinator経由で
// newsReaderを走らせる。TriggerEngine (src/trigger-engine.js) は現状interval/hotkeyしか
// 知らないため、それとは独立したcomponent (同じstart()/stop()の流儀) として実装する —
// 実際のqueue投入はAutomationCoordinator.run("news", reader)がnewsReader.run()を呼ぶだけで、
// #186の「delivery stage以外は音声queueへ触らない」不変条件はそのまま保たれる。
//
// config.news.scheduleが無い/enabled: falseの既存設定では#tick()が即returnするだけで、
// 挙動は完全に既存のまま (opt-inのみ)。

import { resolveDueSlot } from "./news-schedule-policy.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;
const KEEP_FIRED_KEYS_MS = 2 * 24 * HOUR_MS; // 日付境界をまたいでもprune漏れが無いよう2日分保持

// setInterval/clearIntervalはWindowのbranded methodであり、`this.setIntervalFn(...)`の
// ようにinstance property経由で呼ぶとreceiverがNewsScheduleRunnerインスタンスになって
// しまい、ブラウザの内部brand checkに落ちて "TypeError: Illegal invocation" になる
// (bareな`setInterval(...)`呼び出しなら問題ない)。既定値を素の関数参照ではなく、内部で
// bare呼び出しをするarrow関数でラップして防ぐ。
const defaultSetInterval = (fn, ms) => setInterval(fn, ms);
const defaultClearInterval = (id) => clearInterval(id);

export class NewsScheduleRunner {
  constructor({ getConfig, automationCoordinator, getReader, isCurrent = () => true, clock = () => Date.now(), log = () => {}, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, setIntervalFn = defaultSetInterval, clearIntervalFn = defaultClearInterval }) {
    this.getConfig = getConfig;
    this.automationCoordinator = automationCoordinator;
    this.getReader = getReader;
    this.isCurrent = isCurrent;
    this.clock = clock;
    this.log = log;
    this.pollIntervalMs = pollIntervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.timer = null;
    this.firedAt = new Map(); // slotKey -> firedAtMs (二重発火防止 + 定期prune)
    this.runTimestamps = []; // 直近1時間のfired時刻 (maxRunsPerHour判定用)
    this.lastFiredAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => this.tick(), this.pollIntervalMs);
  }

  stop() {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  // 通常はstart()が仕掛けたtimerからのみ呼ぶが、テストで直接叩けるようpublicにしておく。
  tick() {
    if (!this.isCurrent()) return;
    const schedule = this.getConfig().news?.schedule;
    if (!schedule?.enabled || !schedule.slots?.length) return;
    const reader = this.getReader();
    if (!reader?.enabled) return;

    const now = this.clock();
    this.#prune(now);
    const runsInLastHour = this.runTimestamps.filter((t) => now - t < HOUR_MS).length;
    const due = resolveDueSlot({
      slots: schedule.slots,
      now: new Date(now),
      firedSlotKeys: new Set(this.firedAt.keys()),
      lastFiredAt: this.lastFiredAt,
      cooldownMinutes: schedule.cooldownMinutes ?? 0,
      maxRunsPerHour: schedule.maxRunsPerHour ?? null,
      runsInLastHour,
    });
    if (!due) return;

    this.firedAt.set(due.slotKey, now);
    this.lastFiredAt = now;
    this.runTimestamps.push(now);
    this.log(`ニュース時刻slot「${due.slot.id}」が発火しました`);
    this.automationCoordinator.run("news", reader);
  }

  #prune(now) {
    for (const [key, firedAt] of this.firedAt) if (now - firedAt > KEEP_FIRED_KEYS_MS) this.firedAt.delete(key);
    this.runTimestamps = this.runTimestamps.filter((t) => now - t < HOUR_MS);
  }
}
