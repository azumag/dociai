import { renderSubscriptionTable } from "../components/subscription-table.js";

// Issue #94: the subscriptions tab — desired/actual diff table plus session/deadline context, all
// sourced from #87's SubscriptionReconciler snapshot (see components/subscription-table.js for the
// per-row rendering and its retry action).
export function renderSubscriptionsView(root, state, callbacks = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = "購読";
  root.append(heading);

  const { subscriptions } = state;
  if (!subscriptions) {
    const loading = document.createElement("p");
    loading.className = "muted";
    loading.textContent = "状態を取得中です";
    root.append(loading);
    return;
  }

  const meta = document.createElement("p");
  meta.className = "muted twitch-subscriptions-meta";
  const parts = [`session: ${subscriptions.sessionId ?? "未接続"}`];
  if (subscriptions.deadlineMissed) parts.push("購読期限を超過しています");
  meta.textContent = parts.join(" / ");
  root.append(meta);

  const tableRoot = document.createElement("div");
  renderSubscriptionTable(tableRoot, subscriptions.entries, { onRetry: () => callbacks.onRetry?.() }, document);
  root.append(tableRoot);
}
