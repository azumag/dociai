import { sendError, sendJson, startHttpMock } from "./http-mock.mjs";

export const BOUYOMI_SCENARIOS = ["success", "delay", "500", "timeout", "cancel"];

export function startBouyomiServer(options = {}) {
  const commands = [];
  return startHttpMock({
    name: "bouyomi",
    scenarios: BOUYOMI_SCENARIOS,
    initialScenario: options.scenario ?? "success",
    host: options.host,
    port: options.port,
    async handler({ req, res, url, scenario, hang }) {
      if (!["/Talk", "/Clear"].includes(url.pathname) || req.method !== "GET") return sendError(res, 404, "not found");
      if (["timeout", "cancel"].includes(scenario)) return await hang();
      if (scenario === "500") return sendError(res, 500, "mock Bouyomi failure");
      if (scenario === "delay") await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 100));
      const command = {
        type: url.pathname.slice(1),
        text: url.searchParams.get("text") ?? "",
        voice: Number(url.searchParams.get("voice") ?? 0),
      };
      commands.push(command);
      return sendJson(res, 200, { ok: true, command });
    },
  }).then((mock) => Object.assign(mock, { commands }));
}
