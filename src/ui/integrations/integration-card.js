import { resolveHealthAction } from "../../health/health-action-registry.js";
import { statusLabel } from "./integration-summary.js";

function dateLabel(value) {
  if (!value) return "未確認";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "未確認" : date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function renderIntegrationCard(document, service, { onSelect = () => {}, onCheck = () => {}, onAction = () => {} } = {}) {
  const article = document.createElement("article");
  const status = service.status ?? "unknown";
  article.className = `integration-card is-${status}`;
  article.dataset.serviceId = service.serviceId;
  article.setAttribute("aria-label", `${service.name ?? service.serviceId}: ${statusLabel(status)}`);

  const header = document.createElement("div"); header.className = "integration-card-head";
  const title = document.createElement("strong"); title.textContent = service.name ?? service.serviceId;
  const badge = document.createElement("span"); badge.className = "integration-status"; badge.textContent = statusLabel(status); badge.dataset.status = status;
  header.append(title, badge);
  const detail = document.createElement("div"); detail.className = "integration-card-detail";
  detail.textContent = `${service.category ?? "integration"} / 最終成功 ${dateLabel(service.lastSuccessAt)}${service.metrics?.latencyMs != null ? ` / ${service.metrics.latencyMs}ms` : ""}`;
  const actions = document.createElement("div"); actions.className = "integration-card-actions";
  const inspect = document.createElement("button"); inspect.type = "button"; inspect.textContent = "詳細"; inspect.addEventListener("click", () => onSelect(service.serviceId));
  const check = document.createElement("button"); check.type = "button"; check.textContent = "確認"; check.addEventListener("click", () => onCheck(service.serviceId));
  const action = document.createElement("button"); action.type = "button"; action.className = "btn-primary"; action.textContent = statusLabel(service.action ?? resolveHealthAction({ code: service.error?.code ?? service.errorCode, category: service.category })); action.addEventListener("click", () => onAction(service.action ?? resolveHealthAction({ code: service.error?.code ?? service.errorCode, category: service.category }), service));
  actions.append(inspect, check, action);
  if (service.retryAt) {
    const retry = document.createElement("span"); retry.className = "integration-retry"; retry.dataset.retryAt = String(new Date(service.retryAt).valueOf()); retry.dataset.retryCountdown = ""; retry.setAttribute("aria-live", "polite"); retry.textContent = "再試行待ち"; actions.append(retry);
  }
  article.append(header, detail, actions);
  return article;
}
