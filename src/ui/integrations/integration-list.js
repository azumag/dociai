import { renderIntegrationCard } from "./integration-card.js";

export function filterIntegrations(services, { category = "", status = "", requiredOnly = false, errorsOnly = false } = {}) {
  return (Array.isArray(services) ? services : Object.values(services ?? {})).filter((service) => {
    if (category && service.category !== category) return false;
    if (status && service.status !== status) return false;
    if (requiredOnly && service.enabled === false) return false;
    if (errorsOnly && !["error", "auth_required", "configuration_required"].includes(service.status)) return false;
    return true;
  });
}

export function renderIntegrationList(root, services, callbacks = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  const filtered = filterIntegrations(services, callbacks.filters);
  if (!filtered.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "条件に一致する連携はありません"; root.append(empty); return; }
  for (const service of filtered) root.append(renderIntegrationCard(document, service, callbacks));
}
