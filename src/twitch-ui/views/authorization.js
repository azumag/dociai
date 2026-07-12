// Issue #94: "signed out/awaiting user/ready/scope missing/reauth UIを実装" + "user code copy、
// browser open、expiry countdown、cancelを実装" + "granted/missing scopeと追加認可actionを表示" +
// "account switch/logout確認を実装" + affiliate/partner注意表示.
//
// SECURITY: only `flow.userCode`/`flow.verificationUri` (TwitchAuthPublicState, #83's own
// deliberately Renderer-safe projection — see electron/shared/twitch/auth-contract.ts) ever reach
// textContent/copy here. `flow` never carries `device_code`/access/refresh tokens by construction,
// so there is no field this file could accidentally leak even by a careless `Object.values()`-style
// render bug — see scripts/test/twitch-ui.test.mjs's DOM/clipboard scan for the standing check.
export function expiryCountdownSeconds(expiresAtIso, nowMs) {
  if (!expiresAtIso) return null;
  const expiresAtMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresAtMs)) return null;
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

function flowStateLabel(auth) {
  if (!auth) return "状態を取得中です";
  if (auth.tokenStatus === "reauth_required") return "再認可が必要です";
  switch (auth.flow.state) {
    case "signed_out": return "未サインインです";
    case "starting": return "認可を準備しています";
    case "awaiting_user": return "Twitchでの認可待ちです";
    case "exchanging": return "トークンを取得しています";
    case "ready": return auth.account ? `${auth.account.login} としてサインイン済み` : "サインイン済み";
    case "error": return `認可エラー: ${auth.flow.error?.message ?? "unknown"}`;
    default: return auth.flow.state;
  }
}

function renderDeviceCodeBox(document, auth, callbacks, busy) {
  const box = document.createElement("div");
  box.className = "twitch-device-code";
  const codeRow = document.createElement("div");
  codeRow.className = "twitch-device-code-row";
  const code = document.createElement("span");
  code.className = "twitch-device-code-value";
  code.textContent = auth.flow.userCode ?? "----";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "コピー";
  copy.disabled = !auth.flow.userCode;
  copy.addEventListener("click", () => callbacks.onCopy?.(auth.flow.userCode));
  codeRow.append(code, copy);
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "Twitchで開く";
  openButton.disabled = Boolean(busy.openVerificationUri) || !auth.flow.verificationUri;
  openButton.addEventListener("click", () => callbacks.onOpenVerificationUri?.());
  const countdown = document.createElement("p");
  countdown.className = "twitch-device-code-countdown";
  countdown.dataset.expiresAt = auth.flow.expiresAt ?? "";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "キャンセル";
  cancelButton.disabled = Boolean(busy.cancelAuth);
  cancelButton.addEventListener("click", () => callbacks.onCancelAuth?.());
  box.append(codeRow, openButton, countdown, cancelButton);
  return box;
}

function renderScopeList(document, auth, callbacks, busy) {
  const section = document.createElement("div");
  section.className = "twitch-scope-summary";
  const granted = document.createElement("p");
  granted.textContent = `付与済みscope: ${auth.grantedScopes.join(", ") || "なし"}`;
  section.append(granted);
  if (auth.scopeState === "scope_missing") {
    const missing = document.createElement("p");
    missing.className = "twitch-scope-missing";
    missing.textContent = `不足scope: ${auth.missingScopes.join(", ")}`;
    const upgrade = document.createElement("button");
    upgrade.type = "button";
    upgrade.textContent = "追加認可を開始";
    upgrade.disabled = Boolean(busy.upgradeScopes);
    upgrade.addEventListener("click", () => callbacks.onUpgradeScopes?.());
    section.append(missing, upgrade);
  }
  return section;
}

function renderAccountActions(document, auth, callbacks, busy) {
  const section = document.createElement("div");
  section.className = "btn-row twitch-account-actions";
  const switchButton = document.createElement("button");
  switchButton.type = "button";
  switchButton.textContent = "アカウント切替";
  switchButton.disabled = Boolean(busy.switchAccount);
  switchButton.addEventListener("click", () => callbacks.onRequestSwitchAccount?.());
  const logoutButton = document.createElement("button");
  logoutButton.type = "button";
  logoutButton.textContent = "ログアウト";
  logoutButton.disabled = Boolean(busy.logout);
  logoutButton.addEventListener("click", () => callbacks.onRequestLogout?.());
  section.append(switchButton, logoutButton);
  return section;
}

function renderConfirmDialog(document, confirmDialog, callbacks) {
  const box = document.createElement("div");
  box.className = "twitch-confirm-dialog";
  box.setAttribute("role", "alertdialog");
  const message = document.createElement("p");
  message.textContent = confirmDialog.action === "logout"
    ? "ログアウトすると現在の接続・購読も停止します。よろしいですか？"
    : "アカウントを切替えると現在の接続・購読は一旦停止します。よろしいですか？";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.textContent = "実行する";
  confirm.addEventListener("click", () => callbacks.onConfirmDialog?.(confirmDialog.action));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "キャンセル";
  cancel.addEventListener("click", () => callbacks.onCancelConfirmDialog?.());
  box.append(message, confirm, cancel);
  return box;
}

export function renderAuthorizationView(root, state, callbacks = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  const { auth, busy = {}, confirmDialog } = state;

  const heading = document.createElement("h2");
  heading.textContent = "認可";
  const status = document.createElement("p");
  status.className = "twitch-auth-status";
  status.textContent = flowStateLabel(auth);
  root.append(heading, status);

  if (!auth) return;

  if (auth.affiliatePartnerNoteApplicable) {
    const note = document.createElement("p");
    note.className = "twitch-affiliate-note muted";
    // Static, config-derived note — NOT an account-capability check. See overview-contract.ts's
    // TwitchAuthOverview.affiliatePartnerNoteApplicable doc comment for why.
    note.textContent = "Bits/サブスクのイベントはTwitchでAffiliate/Partner認定済みのチャンネルでのみ発生します。イベントが来ない場合、設定ミスではなくこの認定状況が原因のことがあります。";
    root.append(note);
  }

  const inFlightStates = new Set(["starting", "awaiting_user", "exchanging"]);
  if (inFlightStates.has(auth.flow.state)) {
    root.append(renderDeviceCodeBox(document, auth, callbacks, busy));
  } else if (auth.tokenStatus !== "valid") {
    const startButton = document.createElement("button");
    startButton.type = "button";
    startButton.textContent = auth.tokenStatus === "reauth_required" ? "再認可を開始" : "Twitchで連携開始";
    startButton.disabled = Boolean(busy.startAuth) || !auth.clientIdConfigured;
    startButton.addEventListener("click", () => callbacks.onStartAuth?.());
    root.append(startButton);
  } else {
    root.append(renderScopeList(document, auth, callbacks, busy));
    root.append(renderAccountActions(document, auth, callbacks, busy));
  }

  if (confirmDialog) root.append(renderConfirmDialog(document, confirmDialog, callbacks));
}

/** Live-updates the Device Code expiry countdown from its `data-expires-at` timestamp — same
 * interval-driven re-scan idiom as components/connection-card.js's updateConnectionCountdown(). */
export function updateAuthorizationCountdown(root, nowMs) {
  const element = root?.querySelector?.("[data-expires-at]");
  if (!element) return;
  const remaining = expiryCountdownSeconds(element.dataset.expiresAt, nowMs);
  element.textContent = remaining === null ? "" : remaining > 0 ? `有効期限まで ${remaining}秒` : "有効期限切れです";
}
