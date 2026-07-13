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
  //
  // Issue #177 double-fire investigation: a Twitch cheer's own chat message (if the user typed one
  // alongside their Cheermote) arrives as an ordinary IRC PRIVMSG line — see
  // src/twitch-chat/twitch-chat-session.js's own "bits" tag forwarding — in ADDITION to the
  // separate channel.cheer EventSub notification the event-trigger pipeline
  // (src/app/runtime-factory.js's eventTriggerRunner) already reacts to. Without this guard, a
  // keyword/random trigger configured here could ALSO fire an AI response for the identical
  // real-world cheer, double-answering the same action. A `comment.bits` value therefore skips
  // keyword/random dispatch entirely (the comment is still recorded/displayed/read aloud by
  // whatever calls handleComment() — this method is the ONLY place AI-response triggering
  // happens). Investigated and found NARROWER than #54/#177's own framing assumed: a resub/
  // subscribe/gift-sub's accompanying message is delivered over Twitch IRC as a USERNOTICE, not a
  // PRIVMSG, and this repo's own IRC parsers (twitch-irc-parser.js/irc-parser.ts) don't parse
  // USERNOTICE into anything `handleComment()` ever receives at all — so only `cheer` has a real
  // double-fire path through this method today; no equivalent guard is needed for resub/subscribe.
  handleComment(comment) {
    if (typeof comment?.bits === "number" && comment.bits > 0) return [];
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
