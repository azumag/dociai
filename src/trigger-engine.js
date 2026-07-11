// トリガーエンジン (issue #7)
// keyword / hotkey / interval / random / manual の発火条件を管理する。
// 発火は onFire(triggerId, { comment?, reason, manual }) に一本化する。

const MODIFIER_NAMES = ["alt", "ctrl", "control", "shift", "meta", "cmd", "command"];

export function matchHotkey(event, spec) {
  const parts = String(spec).split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const key = parts.filter((p) => !MODIFIER_NAMES.includes(p)).pop();
  if (!key) return false;
  const need = {
    alt: parts.includes("alt"),
    ctrl: parts.includes("ctrl") || parts.includes("control"),
    shift: parts.includes("shift"),
    meta: parts.includes("meta") || parts.includes("cmd") || parts.includes("command"),
  };
  if (event.altKey !== need.alt || event.ctrlKey !== need.ctrl) return false;
  if (event.shiftKey !== need.shift || event.metaKey !== need.meta) return false;
  const code = event.code.toLowerCase();
  // macOSではAlt+数字が記号になるため e.code でも照合する
  return event.key.toLowerCase() === key || code === `digit${key}` || code === `key${key}`;
}

export class TriggerEngine {
  constructor(triggers, { onFire, log = () => {} }) {
    this.triggers = triggers ?? {};
    this.onFire = onFire;
    this.log = log;
    this.timers = [];
    this.keyHandler = null;
    this.unsubscribeGlobalShortcut = null;
    this.unsubscribeShortcutStatus = null;
  }

  start() {
    for (const [id, t] of Object.entries(this.triggers)) {
      if (t.type === "interval") {
        const ms = (t.minutes ?? 0) * 60000 + (t.seconds ?? 0) * 1000;
        if (ms >= 1000) {
          this.timers.push(setInterval(() => this.fire(id, { reason: "interval" }), ms));
          this.log(`intervalトリガー "${id}" を開始 (${Math.round(ms / 1000)}秒ごと)`);
        }
      }
    }
    this.keyHandler = (e) => {
      // 入力欄でのタイピングには反応しない (修飾キーつきは許可)
      const inField = /^(input|textarea|select)$/i.test(e.target?.tagName ?? "");
      for (const [id, t] of Object.entries(this.triggers)) {
        if (t.type !== "hotkey" || !matchHotkey(e, t.keys)) continue;
        if (inField && !(e.altKey || e.ctrlKey || e.metaKey)) continue;
        e.preventDefault();
        this.fire(id, { reason: "hotkey" });
      }
    };
    window.addEventListener("keydown", this.keyHandler);
    const events = globalThis.dociai?.events;
    if (typeof events?.subscribe === "function") {
      this.unsubscribeGlobalShortcut = events.subscribe("shortcut:trigger", (event) => {
        const triggerId = event?.triggerId;
        const trigger = this.triggers[triggerId];
        if (trigger?.type === "hotkey" && trigger.global === true) this.fire(triggerId, { reason: "global-hotkey" });
      });
      this.unsubscribeShortcutStatus = events.subscribe("shortcut:status", (status) => {
        for (const entry of status?.entries ?? []) if (!entry.registered) this.log(`グローバルホットキー "${entry.triggerId}" を登録できません: ${entry.reason ?? "unknown"}`);
      });
    } else {
      for (const [id, trigger] of Object.entries(this.triggers)) if (trigger.type === "hotkey" && trigger.global === true) this.log(`グローバルホットキー "${id}" はBrowser版では無視されます`);
    }
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    this.unsubscribeGlobalShortcut?.();
    this.unsubscribeShortcutStatus?.();
    this.unsubscribeGlobalShortcut = null;
    this.unsubscribeShortcutStatus = null;
  }

  // コメント1件をkeyword/randomトリガーに通し、発火したトリガーIDを返す
  handleComment(comment) {
    const fired = [];
    for (const [id, t] of Object.entries(this.triggers)) {
      if (t.type === "keyword" && (t.keywords ?? []).some((k) => comment.text.includes(k))) {
        fired.push(id);
      } else if (t.type === "random" && Math.random() < (t.probability ?? 0)) {
        fired.push(id);
      }
    }
    for (const id of fired) this.fire(id, { comment, reason: "comment" });
    return fired;
  }

  // UIボタンやショートカットからの手動発火にも使う
  fire(triggerId, { comment = null, reason = "manual", personaId = null } = {}) {
    this.onFire(triggerId, {
      trigger: this.triggers[triggerId] ?? null,
      comment,
      reason,
      personaId,
      manual: reason === "manual" || reason === "hotkey",
    });
  }
}
