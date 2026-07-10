import { readJson, sendError, sendJson, startHttpMock } from "./http-mock.mjs";

export const AI_SCENARIOS = ["success", "stream", "401", "429", "500", "timeout"];

export function startAiServer(options = {}) {
  return startHttpMock({
    name: "ai",
    scenarios: AI_SCENARIOS,
    initialScenario: options.scenario ?? "success",
    host: options.host,
    port: options.port,
    async handler({ req, res, url, scenario, hang }) {
      if (url.pathname === "/v1/models") {
        sendJson(res, 200, { data: [{ id: "mock-model", object: "model" }] });
        return;
      }
      if (!["/v1/chat/completions", "/anthropic/v1/messages"].includes(url.pathname) || req.method !== "POST") {
        sendError(res, 404, "not found");
        return;
      }
      await readJson(req);
      if (scenario === "timeout") return await hang();
      if (["401", "429", "500"].includes(scenario)) {
        const status = Number(scenario);
        sendError(res, status, `mock AI ${status}`);
        return;
      }
      if (scenario === "stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "モック" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "応答" } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      if (url.pathname.startsWith("/anthropic/")) {
        sendJson(res, 200, { id: "msg_mock", type: "message", role: "assistant", content: [{ type: "text", text: "モック応答" }] });
        return;
      }
      sendJson(res, 200, {
        id: "chatcmpl_mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "モック応答" }, finish_reason: "stop" }],
      });
    },
  });
}
