// ペルソナルーター (issue #4)
// どのペルソナが反応するかを決め、maxRepliesPerComment と cooldownSeconds を守る。

export class PersonaRouter {
  constructor(personas, routerCfg = {}) {
    this.personas = personas.map((p) => ({ ...p }));
    this.maxRepliesPerComment = routerCfg.maxRepliesPerComment ?? 1;
    this.cooldownSeconds = routerCfg.cooldownSeconds ?? 8;
    this.defaultPersonaId = routerCfg.defaultPersona ?? this.personas[0]?.id;
    this.lastReplyAt = new Map(); // personaId -> epoch ms
    this.repliesByComment = new Map(); // commentId -> count
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
    for (const p of candidates) {
      if (!p.enabled) {
        skipped.push({ persona: p, reason: "無効化中" });
        continue;
      }
      if (!ignoreCooldown && this.#inCooldown(p)) {
        skipped.push({ persona: p, reason: `クールダウン中 (${this.cooldownSeconds}秒)` });
        continue;
      }
      if (comment && (this.repliesByComment.get(comment.id) ?? 0) + selected.length >= this.maxRepliesPerComment) {
        skipped.push({ persona: p, reason: `1コメント最大${this.maxRepliesPerComment}応答に到達` });
        continue;
      }
      selected.push(p);
    }
    return { selected, skipped };
  }

  // 応答開始時に呼ぶ。二重応答を防ぐため、AI呼び出しの完了を待たずに記録する。
  recordReply(persona, comment = null) {
    this.lastReplyAt.set(persona.id, Date.now());
    if (comment) {
      this.repliesByComment.set(comment.id, (this.repliesByComment.get(comment.id) ?? 0) + 1);
    }
  }

  cooldownRemaining(persona) {
    const last = this.lastReplyAt.get(persona.id);
    if (!last) return 0;
    return Math.max(0, this.cooldownSeconds - (Date.now() - last) / 1000);
  }

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
