// ペルソナルーター (issue #4)
// どのペルソナが反応するかを決め、maxRepliesPerComment と cooldownSeconds を守る。

import { commentResponseBudgetKey } from "./personas/response-budget-key.js";
import { ResponseBudgetTracker } from "./personas/response-budget-tracker.js";

export class PersonaRouter {
  constructor(personas, routerCfg = {}, { budgetTracker = null, clock = () => Date.now() } = {}) {
    this.personas = personas.map((p) => ({ ...p }));
    this.maxRepliesPerComment = routerCfg.maxRepliesPerComment ?? 1;
    this.cooldownSeconds = routerCfg.cooldownSeconds ?? 8;
    this.defaultPersonaId = routerCfg.defaultPersona ?? this.personas[0]?.id;
    this.clock = clock;
    this.budgetTracker = budgetTracker ?? new ResponseBudgetTracker({ ttlMs: (routerCfg.historyTtlSeconds ?? 7200) * 1000, maxEntries: routerCfg.historyMaxEntries ?? 2000, clock });
    this.lastReplyAt = new Map(); // personaId -> epoch ms
    this.listeners = new Set();
  }

  list() {
    return this.personas;
  }

  get(id) {
    return this.personas.find((p) => p.id === id) ?? null;
  }

  defaultPersona() {
    return this.get(this.defaultPersonaId) ?? this.personas[0] ?? null;
  }

  setEnabled(id, enabled) {
    const p = this.get(id);
    if (!p) return;
    p.enabled = enabled;
    this.#notify();
  }

  // triggerId に反応すべきペルソナを選ぶ。personaId 指定時 (手動/ホットキー) はそのペルソナのみ。
  // ignoreCooldown=true でクールダウンを無視する (配信者の明示操作のため)。無効ペルソナは常に反応しない。
  select(triggerId, { comment = null, personaId = null, ignoreCooldown = false } = {}) {
    const candidates = personaId
      ? [this.get(personaId)].filter(Boolean)
      : this.personas.filter((p) => (p.triggers ?? []).includes(triggerId));

    const selected = [];
    const skipped = [];
    const budgetKey = commentResponseBudgetKey(comment);
    for (const p of candidates) {
      if (!p.enabled) {
        skipped.push({ persona: p, reason: "無効化中" });
        continue;
      }
      if (!ignoreCooldown && this.#inCooldown(p)) {
        skipped.push({ persona: p, reason: `クールダウン中 (${this.cooldownSeconds}秒)` });
        continue;
      }
      const reservation = budgetKey ? this.budgetTracker.reserve(budgetKey, this.maxRepliesPerComment, this.clock()) : null;
      if (budgetKey && !reservation) {
        skipped.push({ persona: p, reason: `1コメント最大${this.maxRepliesPerComment}応答に到達` });
        continue;
      }
      selected.push({ persona: p, reservation, budgetKey });
    }
    return { selected, skipped };
  }

  // 応答開始時に呼ぶ。予約済みならcommitし、AI呼び出し前に上限を確定させる。
  commitSelection(selection) {
    const persona = selection?.persona ?? selection;
    if (!persona) return false;
    const committed = selection?.reservation ? this.budgetTracker.commit(selection.reservation, this.clock()) : true;
    if (committed) this.lastReplyAt.set(persona.id, this.clock());
    return committed;
  }

  releaseSelection(selection) { return selection?.reservation ? this.budgetTracker.release(selection.reservation) : false; }

  // 後方互換: 直接呼び出す既存コードは応答開始を記録する。新規フローはcommitSelectionを使う。
  recordReply(persona, comment = null) {
    const selection = { persona, reservation: null };
    const key = commentResponseBudgetKey(comment);
    if (key) selection.reservation = this.budgetTracker.reserve(key, this.maxRepliesPerComment, this.clock());
    return selection.reservation === null && key ? false : this.commitSelection(selection);
  }

  cooldownRemaining(persona) {
    const last = this.lastReplyAt.get(persona.id);
    if (!last) return 0;
    return Math.max(0, this.cooldownSeconds - (this.clock() - last) / 1000);
  }

  budgetStats() { return this.budgetTracker.stats(); }
  dispose() { this.budgetTracker.clear(); this.lastReplyAt.clear(); this.listeners.clear(); }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #inCooldown(persona) {
    return this.cooldownRemaining(persona) > 0;
  }

  #notify() {
    for (const fn of this.listeners) fn(this);
  }
}
