const SECRET_KEY = /api[-_]?key|token|secret|authorization|password|cookie/i;

export function redactLogValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redactLogValue(nestedValue, nestedKey)]));
}

export function createStructuredLogContext(input: { serviceId: string; requestId?: string; generation?: number; ownerId?: string; fields?: Record<string, unknown> }): Record<string, unknown> {
  return redactLogValue({ serviceId: input.serviceId, requestId: input.requestId, generation: input.generation, ownerId: input.ownerId, ...input.fields }) as Record<string, unknown>;
}
