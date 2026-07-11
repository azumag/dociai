import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticExport, serializeDiagnosticExport } from "../../src/health/diagnostic-export.js";
import { filterIntegrations } from "../../src/ui/integrations/integration-list.js";
import { summarizeHealth } from "../../src/ui/integrations/integration-summary.js";

test("integration health summary counts non-color status categories", () => {
  const summary = summarizeHealth([
    { serviceId: "ai", status: "ready" }, { serviceId: "feed", status: "degraded" },
    { serviceId: "auth", status: "auth_required", critical: true }, { serviceId: "model", status: "checking" },
    { serviceId: "obs", status: "unknown" },
  ]);
  assert.deepEqual(summary, { total: 5, ready: 1, warn: 1, error: 1, checking: 1, unknown: 1, critical: 1, overall: "error" });
});

test("integration filters support category, required, and errors", () => {
  const services = [
    { serviceId: "ai", category: "model", status: "ready", enabled: true },
    { serviceId: "twitch", category: "stream", status: "error", enabled: true },
    { serviceId: "obs", category: "stream", status: "disabled", enabled: false },
  ];
  assert.deepEqual(filterIntegrations(services, { category: "stream", requiredOnly: true }).map((item) => item.serviceId), ["twitch"]);
  assert.deepEqual(filterIntegrations(services, { errorsOnly: true }).map((item) => item.serviceId), ["twitch"]);
});

test("diagnostic export is bounded and excludes secrets, raw data, and paths", () => {
  const payload = createDiagnosticExport({ app: "dociai", build: "test", generatedAt: "2026-07-12T00:00:00Z", services: [{
    serviceId: "ai", category: "model", status: "error", error: { code: "AUTH", message: "token=do-not-export" },
    metrics: { latencyMs: 42, tokenCount: 99, prompt: "do-not-export", path: "/Users/secret" },
    timeline: Array.from({ length: 20 }, (_, index) => ({ at: index, status: "error", errorCode: "AUTH", raw: "do-not-export" })),
    headers: { authorization: "do-not-export" }, rawPayload: "do-not-export", absolutePath: "/Users/secret",
  }] });
  const text = serializeDiagnosticExport(payload);
  assert.equal(payload.services[0].timeline.length, 12);
  assert.equal(payload.services[0].metrics.latencyMs, 42);
  assert.equal("tokenCount" in payload.services[0].metrics, false);
  assert.equal(text.includes("do-not-export"), false);
  assert.equal(text.includes("/Users/secret"), false);
});
