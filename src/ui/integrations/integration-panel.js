import { HealthNotificationPolicy } from "../../health/health-notification-policy.js";
import { createDiagnosticExport } from "../../health/diagnostic-export.js";
import { filterIntegrations, renderIntegrationList } from "./integration-list.js";
import { renderIntegrationDetails } from "./integration-details.js";
import { renderSummary } from "./integration-summary.js";
import { DiagnosticExportDialog } from "./diagnostic-export-dialog.js";

function arrayServices(snapshot) {
  const services = snapshot?.services ?? snapshot ?? [];
  return Array.isArray(services) ? services : Object.values(services);
}

export class IntegrationPanel {
  constructor(dialog, { inlineRoot = null, summaryRoot = null, miniRoot = null, document = dialog?.ownerDocument ?? globalThis.document, runner = null, onAction = () => {}, onNotify = () => {}, onExport = null, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
    this.dialog = dialog; this.document = document; this.runner = runner; this.onAction = onAction; this.onNotify = onNotify; this.now = now; this.setIntervalImpl = setIntervalImpl; this.clearIntervalImpl = clearIntervalImpl; this.services = []; this.selectedId = null; this.filters = {}; this.previous = new Map(); this.policy = new HealthNotificationPolicy({ now }); this.timer = null;
    this.summaryRoot = summaryRoot; this.miniRoot = miniRoot;
    if (!dialog || !document?.createElement) return;
    dialog.setAttribute("aria-labelledby", "integration-health-title");
    const title = document.createElement("h2"); title.id = "integration-health-title"; title.textContent = "連携ヘルス詳細";
    const controls = document.createElement("div"); controls.className = "integration-filters";
    this.category = document.createElement("select"); this.category.setAttribute("aria-label", "カテゴリで絞り込み"); this.category.addEventListener("change", () => { this.filters.category = this.category.value; this.render(); });
    this.status = document.createElement("select"); this.status.setAttribute("aria-label", "状態で絞り込み"); this.status.addEventListener("change", () => { this.filters.status = this.status.value; this.render(); });
    const required = document.createElement("label"); this.required = document.createElement("input"); this.required.type = "checkbox"; this.required.addEventListener("change", () => { this.filters.requiredOnly = this.required.checked; this.render(); }); required.append(this.required, " 有効のみ");
    const errors = document.createElement("label"); this.errors = document.createElement("input"); this.errors.type = "checkbox"; this.errors.addEventListener("change", () => { this.filters.errorsOnly = this.errors.checked; this.render(); }); errors.append(this.errors, " エラーのみ");
    controls.append(this.category, this.status, required, errors);
    const toolbar = document.createElement("div"); toolbar.className = "btn-row";
    const all = document.createElement("button"); all.type = "button"; all.textContent = "全連携を確認"; all.addEventListener("click", () => this.checkAll());
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "確認を取消"; cancel.addEventListener("click", () => this.cancelAll());
    const exportButton = document.createElement("button"); exportButton.type = "button"; exportButton.textContent = "診断を出力"; exportButton.addEventListener("click", () => onExport?.(this.services));
    const close = document.createElement("button"); close.type = "button"; close.textContent = "閉じる"; close.addEventListener("click", () => this.close());
    toolbar.append(all, cancel, exportButton, close);
    this.listRoot = document.createElement("div"); this.listRoot.className = "integration-list";
    this.detailsRoot = document.createElement("aside"); this.detailsRoot.className = "integration-details"; this.detailsRoot.setAttribute("aria-live", "polite");
    const columns = document.createElement("div"); columns.className = "integration-panel-columns"; columns.append(this.listRoot, this.detailsRoot);
    dialog.replaceChildren(title, controls, toolbar, columns);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
    if (inlineRoot) inlineRoot.dataset.integrationPanel = "ready";
    this.timer = setIntervalImpl(() => this.updateCountdowns(), 1000);
  }

  setSnapshot(snapshot) {
    const next = arrayServices(snapshot).map((service) => ({ ...service, serviceId: service.serviceId ?? service.id ?? "unknown" }));
    for (const service of next) {
      const previous = this.previous.get(service.serviceId);
      if (!previous && ["error", "auth_required", "configuration_required"].includes(service.status) && service.critical) this.onNotify({ type: "critical", service });
      if (previous && previous !== service.status) {
        const notice = this.policy.publish(service);
        if (notice.emitted && service.status === "ready" && ["error", "auth_required", "configuration_required"].includes(previous)) this.onNotify({ type: "recovery", service });
        if (notice.emitted && ["error", "auth_required", "configuration_required"].includes(service.status) && service.critical) this.onNotify({ type: "critical", service });
      }
      this.previous.set(service.serviceId, service.status);
    }
    this.services = next; if (!this.selectedId && next[0]) this.selectedId = next[0].serviceId; this.render();
  }

  render() {
    if (!this.document || !this.dialog) return;
    renderSummary(this.summaryRoot, this.services, this.document);
    const visible = filterIntegrations(this.services, this.filters);
    if (this.miniRoot) renderIntegrationList(this.miniRoot, this.services.slice(0, 6), { ...this.callbacks(), filters: {} }, this.document);
    renderIntegrationList(this.listRoot, this.services, { ...this.callbacks(), filters: this.filters }, this.document);
    renderIntegrationDetails(this.detailsRoot, this.services.find((service) => service.serviceId === this.selectedId) ?? visible[0], this.callbacks(), this.document);
    this.category.replaceChildren(new Option("全カテゴリ", ""), ...[...new Set(this.services.map((service) => service.category).filter(Boolean))].sort().map((value) => new Option(value, value)));
    this.status.replaceChildren(new Option("全状態", ""), ...[...new Set(this.services.map((service) => service.status).filter(Boolean))].sort().map((value) => new Option(value, value)));
    this.category.value = this.filters.category ?? ""; this.status.value = this.filters.status ?? "";
  }

  callbacks() { return { onSelect: (id) => { this.selectedId = id; this.render(); }, onCheck: (id) => this.check(id), onAction: (action, service) => this.onAction(action, service) }; }
  async check(serviceId) { if (this.runner?.check) return this.runner.check(serviceId); return this.onAction("retry", this.services.find((service) => service.serviceId === serviceId)); }
  async checkAll() {
    const ids = this.services.map((service) => service.serviceId); const token = (this.checkToken ?? 0) + 1; this.checkToken = token;
    if (this.runner?.checkAll) return this.runner.checkAll(ids, { onProgress: (event) => this.onNotify({ type: "progress", event }) });
    let completed = 0;
    const results = await Promise.all(ids.map(async (id) => {
      if (token !== this.checkToken) return { serviceId: id, status: "cancelled" };
      const result = await this.check(id); completed += 1;
      this.onNotify({ type: "progress", event: { completed, total: ids.length, serviceId: id, result } });
      return result;
    }));
    return results;
  }
  cancelAll() { this.checkToken = (this.checkToken ?? 0) + 1; this.runner?.cancelGeneration?.(Number.MAX_SAFE_INTEGER); this.onNotify({ type: "cancelled" }); }
  open(serviceId = null) { if (serviceId) this.selectedId = serviceId; if (typeof this.dialog?.showModal === "function") this.dialog.showModal(); else if (this.dialog) this.dialog.open = true; this.render(); }
  close() { if (!this.dialog) return; if (this.dialog.open && typeof this.dialog.close === "function") this.dialog.close(); else this.dialog.open = false; }
  updateCountdowns() { for (const element of this.document?.querySelectorAll?.("[data-retry-countdown]") ?? []) { const remaining = Math.max(0, Math.ceil((Number(element.dataset.retryAt) - this.now()) / 1000)); element.textContent = remaining > 0 ? `再試行まで ${remaining}秒` : "再試行可能"; } }
  exportPayload({ app = "dociai", build = "web" } = {}) { return createDiagnosticExport({ app, build, generatedAt: this.now(), services: this.services }); }
  dispose() { if (this.timer) this.clearIntervalImpl(this.timer); this.timer = null; this.policy.dispose(); }
}
