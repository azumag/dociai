// Issue #94: "desired/actual subscription tableとrevocation/error actionを実装" — driven by #87's
// SubscriptionReconciler snapshot (electron/main/services/twitch/eventsub/subscription-reconciler.ts)
// via twitch-composition.ts's TwitchSubscriptionsOverview. Every row is a DESIRED subscription (or a
// lingering untracked one the reconciler discovered) — the table never needs a separate "desired"
// vs "actual" column set because the reconciler already folds that diff into `entryStatus`.

const STATUS_LABEL = {
  pending: "未作成", creating: "作成中", active: "有効", missing_scope: "scope不足",
  unauthorized: "認可エラー", error: "エラー", suppressed: "一時停止中", removed: "削除済み",
};

const FEATURE_LABEL = { bits: "Bits", subscriptions: "サブスク", redemptions: "チャンネルポイント" };

const RETRYABLE_STATUSES = new Set(["error", "unauthorized", "missing_scope", "suppressed"]);

export function renderSubscriptionTable(root, entries, callbacks = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  if (!entries || entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "購読対象がありません";
    root.append(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "twitch-subscription-table";
  const head = document.createElement("tr");
  for (const label of ["種別", "機能", "状態", "詳細", "操作"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const entry of entries) {
    const row = document.createElement("tr");
    row.dataset.subscriptionKey = entry.key;
    row.className = `twitch-subscription-row is-${entry.entryStatus}`;
    const type = document.createElement("td");
    type.textContent = entry.type;
    const feature = document.createElement("td");
    feature.textContent = entry.feature ? (FEATURE_LABEL[entry.feature] ?? entry.feature) : "-";
    const status = document.createElement("td");
    status.textContent = STATUS_LABEL[entry.entryStatus] ?? entry.entryStatus;
    const detail = document.createElement("td");
    detail.textContent = subscriptionDetailText(entry);
    const actions = document.createElement("td");
    if (RETRYABLE_STATUSES.has(entry.entryStatus)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "再接続して再試行";
      retry.addEventListener("click", () => callbacks.onRetry?.(entry));
      actions.append(retry);
    }
    row.append(type, feature, status, detail, actions);
    table.append(row);
  }
  root.append(table);
}

function subscriptionDetailText(entry) {
  if (entry.revocation) return `取消: ${entry.revocation.message}`;
  if (entry.lastError) return entry.lastError.message;
  if (entry.suppressedUntilMs) return `再試行は ${new Date(entry.suppressedUntilMs).toLocaleTimeString("ja-JP")} 以降`;
  if (entry.actualStatus) return entry.actualStatus;
  return "-";
}
