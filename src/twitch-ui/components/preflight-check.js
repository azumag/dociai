// Issue #94: "client ID、auth、scope、broadcaster、session、subscription、rule、speech、OBSの
// preflightを実装" — a pass/fail/warn checklist so "配信前に認可・接続・購読の成否を1画面で判断
// できる" (the issue's own acceptance criterion). Split into a pure computation (computePreflight
// Checks, tested directly — see scripts/test/twitch-ui.test.mjs) and a DOM render function, the same
// pairing src/ui/integrations/integration-list.js uses for filterIntegrations/renderIntegrationList.
//
// `deepLink` on a failing/warning row is either `{ kind: "view", view: "authorization"|"subscriptions"|"overview" }`
// (switches the twitch-ui tab) or `{ kind: "settings" }` (asks the mounting code to open the app's
// general Settings dialog — rule/speech/OBS are owned by other subsystems this screen has no
// in-screen editor for). "failed checkから該当view/settingsへdeep-link".

const STATUS_LABEL = { pass: "OK", warn: "要確認", fail: "NG" };

function toView(view) { return { kind: "view", view }; }
const SETTINGS_LINK = { kind: "settings" };

function clientIdCheck(auth) {
  if (!auth) return { id: "client-id", label: "Client ID", status: "warn", detail: "状態を取得中です", deepLink: toView("authorization") };
  return { id: "client-id", label: "Client ID", status: auth.clientIdConfigured ? "pass" : "fail", detail: auth.clientIdConfigured ? "設定済み" : "TWITCH_CLIENT_IDが未設定です", deepLink: toView("authorization") };
}

function authCheck(auth) {
  if (!auth) return { id: "auth", label: "認可", status: "warn", detail: "状態を取得中です", deepLink: toView("authorization") };
  if (auth.tokenStatus === "valid") return { id: "auth", label: "認可", status: "pass", detail: auth.account ? `${auth.account.login} としてログイン済み` : "認可済み", deepLink: toView("authorization") };
  if (auth.tokenStatus === "reauth_required") return { id: "auth", label: "認可", status: "fail", detail: "再認可が必要です", deepLink: toView("authorization") };
  if (["starting", "awaiting_user", "exchanging"].includes(auth.flow.state)) return { id: "auth", label: "認可", status: "warn", detail: "認可手続き中です", deepLink: toView("authorization") };
  return { id: "auth", label: "認可", status: "fail", detail: "未認可です", deepLink: toView("authorization") };
}

function scopeCheck(auth) {
  if (!auth) return { id: "scope", label: "Scope", status: "warn", detail: "状態を取得中です", deepLink: toView("authorization") };
  if (auth.tokenStatus !== "valid") return { id: "scope", label: "Scope", status: "warn", detail: "認可完了後に確認できます", deepLink: toView("authorization") };
  if (auth.scopeState === "ok") return { id: "scope", label: "Scope", status: "pass", detail: "必要scopeを全て保持しています", deepLink: toView("authorization") };
  return { id: "scope", label: "Scope", status: "fail", detail: `不足: ${auth.missingScopes.join(", ") || "unknown"}`, deepLink: toView("authorization") };
}

function broadcasterCheck(auth) {
  if (!auth) return { id: "broadcaster", label: "Broadcaster", status: "warn", detail: "状態を取得中です", deepLink: toView("authorization") };
  if (auth.broadcasterMismatch) return { id: "broadcaster", label: "Broadcaster", status: "fail", detail: `認可accountが一致しません (${auth.broadcasterMismatch.observedLogin})`, deepLink: toView("authorization") };
  if (auth.broadcasterUserId) return { id: "broadcaster", label: "Broadcaster", status: "pass", detail: "確認済み", deepLink: toView("authorization") };
  return { id: "broadcaster", label: "Broadcaster", status: "warn", detail: "初回ログインで確定します", deepLink: toView("authorization") };
}

function sessionCheck(connection) {
  if (!connection) return { id: "session", label: "EventSub session", status: "warn", detail: "状態を取得中です", deepLink: toView("overview") };
  if (connection.status === "running") return { id: "session", label: "EventSub session", status: "pass", detail: "接続中です", deepLink: toView("overview") };
  if (["connecting", "reconnect_pending", "specified_reconnect"].includes(connection.status)) return { id: "session", label: "EventSub session", status: "warn", detail: "接続処理中です", deepLink: toView("overview") };
  return { id: "session", label: "EventSub session", status: "fail", detail: "未接続です", deepLink: toView("overview") };
}

function subscriptionCheck(subscriptions) {
  if (!subscriptions) return { id: "subscription", label: "購読", status: "warn", detail: "状態を取得中です", deepLink: toView("subscriptions") };
  const entries = subscriptions.entries ?? [];
  if (entries.length === 0) return { id: "subscription", label: "購読", status: "warn", detail: "購読対象がありません", deepLink: toView("subscriptions") };
  const blocked = entries.filter((entry) => ["error", "unauthorized", "missing_scope"].includes(entry.entryStatus));
  if (blocked.length > 0 || subscriptions.deadlineMissed) return { id: "subscription", label: "購読", status: "fail", detail: `${blocked.length}件の購読に問題があります`, deepLink: toView("subscriptions") };
  const pending = entries.filter((entry) => !["active", "removed"].includes(entry.entryStatus));
  if (pending.length > 0) return { id: "subscription", label: "購読", status: "warn", detail: "購読を確定中です", deepLink: toView("subscriptions") };
  return { id: "subscription", label: "購読", status: "pass", detail: `${entries.length}件すべて有効です`, deepLink: toView("subscriptions") };
}

function tristateCheck(id, label, value) {
  if (value === true) return { id, label, status: "pass", detail: "利用可能です", deepLink: SETTINGS_LINK };
  if (value === false) return { id, label, status: "fail", detail: "未設定です", deepLink: SETTINGS_LINK };
  return { id, label, status: "warn", detail: "状態が不明です", deepLink: SETTINGS_LINK };
}

export function computePreflightChecks(state) {
  const auth = state.auth;
  const context = state.context ?? {};
  return [
    clientIdCheck(auth),
    authCheck(auth),
    scopeCheck(auth),
    broadcasterCheck(auth),
    sessionCheck(state.connection),
    subscriptionCheck(state.subscriptions),
    tristateCheck("rules", "トリガールール", context.triggerRulesConfigured),
    tristateCheck("speech", "音声出力", context.speechAvailable),
    tristateCheck("obs", "OBS表示", context.obsAvailable),
  ];
}

export function renderPreflightChecks(root, checks, { onNavigate = () => {} } = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  const list = document.createElement("ul");
  list.className = "twitch-preflight-list";
  for (const check of checks) {
    const item = document.createElement("li");
    item.className = `twitch-preflight-item is-${check.status}`;
    item.dataset.checkId = check.id;
    const badge = document.createElement("span");
    badge.className = "twitch-preflight-badge";
    badge.textContent = STATUS_LABEL[check.status] ?? check.status;
    const label = document.createElement("span");
    label.className = "twitch-preflight-label";
    label.textContent = check.label;
    const detail = document.createElement("span");
    detail.className = "twitch-preflight-detail";
    detail.textContent = check.detail;
    item.append(badge, label, detail);
    if (check.status !== "pass" && check.deepLink) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = check.deepLink.kind === "settings" ? "設定を開く" : "確認する";
      button.addEventListener("click", () => onNavigate(check.deepLink, check));
      item.append(button);
    }
    list.append(item);
  }
  root.append(list);
}
