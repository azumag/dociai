import { sendError, sendJson, startHttpMock } from "./http-mock.mjs";

export const TODOIST_SCENARIOS = ["success", "empty", "401", "429", "500", "timeout"];

export function startTodoistServer(options = {}) {
  return startHttpMock({
    name: "todoist",
    scenarios: TODOIST_SCENARIOS,
    initialScenario: options.scenario ?? "success",
    host: options.host,
    port: options.port,
    async handler({ req, res, url, scenario, hang }) {
      if (url.pathname !== "/rest/v2/tasks" || req.method !== "GET") return sendError(res, 404, "not found");
      if (scenario === "timeout") return await hang();
      if (["401", "429", "500"].includes(scenario)) return sendError(res, Number(scenario), `mock Todoist ${scenario}`);
      if (scenario === "empty") return sendJson(res, 200, []);
      const cursor = url.searchParams.get("cursor");
      if (!cursor) {
        return sendJson(res, 200, [
          { id: "task-1", content: "配信トピック1", description: "メモ1" },
          { id: "task-2", content: "配信トピック2", description: "メモ2" },
        ], { "X-Next-Cursor": "page-2" });
      }
      if (cursor === "page-2") return sendJson(res, 200, [{ id: "task-3", content: "配信トピック3", description: "メモ3" }]);
      return sendJson(res, 200, []);
    },
  });
}
