const MAX_KEY_PART_LENGTH = 200;

function normalizePart(value) {
  const normalized = String(value ?? "").trim();
  return normalized && normalized.length <= MAX_KEY_PART_LENGTH ? normalized : null;
}

export function createResponseBudgetKey(namespace, id) {
  const safeNamespace = normalizePart(namespace);
  const safeId = normalizePart(id);
  return safeNamespace && safeId ? `${safeNamespace}:${safeId}` : null;
}

export function commentResponseBudgetKey(comment) {
  return createResponseBudgetKey("comment", comment?.id);
}

export function streamEventResponseBudgetKey(event) {
  return createResponseBudgetKey("stream-event", event?.id);
}
