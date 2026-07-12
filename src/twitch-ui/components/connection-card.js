// Issue #94: "connection stateとretry/reconnect countdownを表示" + "manual connect/reconnect/stop
// actionを実装" — driven by #88's ReconnectCoordinator diagnostics via twitch-composition.ts's
// TwitchConnectionOverview. Never renders the EventSub WebSocket URL or a Twitch-specified
// `reconnect_url` (neither is even present in the contract — see overview-contract.ts) — only
// status/session-id/attempt/retry-countdown, none of which are secrets.

const STATUS_LABEL = {
  idle: "未接続", connecting: "接続中", reconnect_pending: "再接続待ち", specified_reconnect: "再接続中(引継ぎ)",
  running: "接続中(稼働)", auth_not_ready: "認可待ち", stopped: "停止",
};

export function retryCountdownSeconds(pendingRetryAtMs, nowMs) {
  if (typeof pendingRetryAtMs !== "number") return null;
  return Math.max(0, Math.ceil((pendingRetryAtMs - nowMs) / 1000));
}

export function renderConnectionCard(root, state, callbacks = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  const { connection, busy = {} } = state;
  root.replaceChildren();

  const heading = document.createElement("h3");
  heading.textContent = "EventSub接続";
  const status = document.createElement("p");
  status.className = "twitch-connection-status";
  status.textContent = connection ? (STATUS_LABEL[connection.status] ?? connection.status) : "状態を取得中です";
  const meta = document.createElement("p");
  meta.className = "twitch-connection-meta muted";
  if (connection) {
    const parts = [`試行回数 ${connection.attempt}`, connection.online ? "オンライン" : "オフライン"];
    if (connection.session?.sessionId) parts.push(`session ${connection.session.sessionId}`);
    meta.textContent = parts.join(" / ");
  }
  const countdown = document.createElement("p");
  countdown.className = "twitch-connection-countdown";
  countdown.dataset.retryAt = connection?.pendingRetryAtMs != null ? String(connection.pendingRetryAtMs) : "";
  countdown.hidden = connection?.pendingRetryAtMs == null;

  const actions = document.createElement("div");
  actions.className = "btn-row";
  const connectButton = document.createElement("button");
  connectButton.type = "button";
  connectButton.textContent = "接続";
  connectButton.disabled = Boolean(busy.connect) || connection?.status === "running";
  connectButton.addEventListener("click", () => callbacks.onConnect?.());
  const reconnectButton = document.createElement("button");
  reconnectButton.type = "button";
  reconnectButton.textContent = "再接続";
  reconnectButton.disabled = Boolean(busy.reconnect);
  reconnectButton.addEventListener("click", () => callbacks.onReconnect?.());
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.textContent = "停止";
  stopButton.disabled = Boolean(busy.stop) || !connection || connection.status === "stopped" || connection.status === "idle";
  stopButton.addEventListener("click", () => callbacks.onStop?.());
  actions.append(connectButton, reconnectButton, stopButton);

  const notices = document.createElement("ul");
  notices.className = "twitch-reconnect-notices";
  notices.setAttribute("aria-live", "polite");
  for (const notice of state.reconnectNotices ?? []) {
    const item = document.createElement("li");
    item.dataset.noticeId = notice.id;
    item.textContent = reconnectNoticeText(notice.event);
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "閉じる";
    dismiss.addEventListener("click", () => callbacks.onDismissNotice?.(notice.id));
    item.append(dismiss);
    notices.append(item);
  }

  root.append(heading, status, meta, countdown, actions, notices);
}

function reconnectNoticeText(event) {
  switch (event.type) {
    case "retry_scheduled": return `再接続を予定しています (試行 ${event.attempt})`;
    case "specified_reconnect_started": return "Twitch指定の再接続を開始しました";
    case "specified_reconnect_succeeded": return "再接続に成功しました";
    case "specified_reconnect_fallback": return `再接続に失敗したため通常再接続に切替えます: ${event.reason}`;
    case "event_gap_warning": return event.message;
    case "duplicate_dropped": return "重複した通知を破棄しました";
    case "stopped": return `接続を停止しました: ${event.reason}`;
    default: return event.type;
  }
}

/** Live-updates every rendered countdown's textContent from its `data-retry-at` timestamp — same
 * "cheap DOM re-scan on an interval" idiom as src/ui/integrations/integration-panel.js's own
 * updateCountdowns(). Call on a ~1s interval while the connection card is visible. */
export function updateConnectionCountdown(root, nowMs) {
  const element = root?.querySelector?.("[data-retry-at]");
  if (!element) return;
  const retryAt = Number(element.dataset.retryAt);
  if (!retryAt) { element.hidden = true; return; }
  const remaining = retryCountdownSeconds(retryAt, nowMs);
  element.hidden = false;
  element.textContent = remaining > 0 ? `再接続まで ${remaining}秒` : "まもなく再接続します";
}
