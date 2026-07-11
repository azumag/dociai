import { resolveHealthAction } from "../../health/health-action-registry.js";
import { statusLabel } from "./integration-summary.js";

function text(document, label, value) {
  const row = document.createElement("div"); row.className = "integration-detail-row";
  const key = document.createElement("dt"); key.textContent = label;
  const val = document.createElement("dd"); val.textContent = value ?? "—";
  row.append(key, val); return row;
}

export function renderIntegrationDetails(root, service, { onAction = () => {}, onCheck = () => {} } = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  if (!service) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "連携を選択すると詳細を表示します"; root.append(empty); return; }
  const heading = document.createElement("h3"); heading.textContent = service.name ?? service.serviceId;
  const state = document.createElement("p"); state.className = "integration-detail-status"; state.textContent = `状態: ${statusLabel(service.status)}`;
  const actions = document.createElement("div"); actions.className = "btn-row";
  const check = document.createElement("button"); check.type = "button"; check.textContent = "今すぐ確認"; check.addEventListener("click", () => onCheck(service.serviceId));
  const actionId = service.action ?? resolveHealthAction({ code: service.error?.code ?? service.errorCode, category: service.category });
  const action = document.createElement("button"); action.type = "button"; action.className = "btn-primary"; action.textContent = `主操作: ${statusLabel(actionId)}`; action.addEventListener("click", () => onAction(actionId, service));
  actions.append(check, action);
  const metrics = document.createElement("dl"); metrics.className = "integration-detail-metrics";
  metrics.append(text(document, "カテゴリ", service.category), text(document, "最終成功", service.lastSuccessAt ? new Date(service.lastSuccessAt).toLocaleString("ja-JP") : "未確認"), text(document, "診断ID", service.diagnosticId ?? "未発行"));
  for (const [key, value] of Object.entries(service.metrics ?? {})) metrics.append(text(document, key, String(value)));
  const timeline = document.createElement("ol"); timeline.className = "integration-timeline";
  for (const event of (service.timeline ?? []).slice(-12).reverse()) { const item = document.createElement("li"); item.textContent = `${event.at ? new Date(event.at).toLocaleTimeString("ja-JP") : "—"} / ${statusLabel(event.status)}${event.errorCode ? ` / ${event.errorCode}` : ""}`; timeline.append(item); }
  if (!timeline.children.length) { const item = document.createElement("li"); item.textContent = "履歴なし"; timeline.append(item); }
  root.append(heading, state, actions, metrics, timeline);
}
