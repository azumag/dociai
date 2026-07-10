import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { readJson, sendError, sendJson } from "./http-mock.mjs";

export const EVENTSUB_SCENARIOS = ["success", "authorization-pending", "token-expired", "revoked", "reconnect", "500"];

function envelope(messageType, payload) {
  return {
    metadata: { message_id: randomUUID(), message_type: messageType, message_timestamp: new Date().toISOString() },
    payload,
  };
}

export async function startEventsubServer(options = {}) {
  let scenario = options.scenario ?? "success";
  if (!EVENTSUB_SCENARIOS.includes(scenario)) throw new Error(`eventsub: unknown scenario ${scenario}`);
  const clients = new Set();
  const subscriptions = [];
  let wsUrl;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__ready") return sendJson(res, 200, { ok: true, name: "eventsub", scenario });
    if (url.pathname === "/__scenario" && req.method === "GET") return sendJson(res, 200, { scenario, scenarios: EVENTSUB_SCENARIOS });
    if (url.pathname === "/__scenario" && req.method === "PUT") {
      const body = await readJson(req);
      if (!EVENTSUB_SCENARIOS.includes(body.scenario)) return sendJson(res, 400, { error: "unknown scenario" });
      scenario = body.scenario;
      return sendJson(res, 200, { scenario });
    }
    if (scenario === "500") return sendError(res, 500, "mock Twitch failure");
    if (url.pathname === "/oauth2/device" && req.method === "POST") {
      return sendJson(res, 200, { device_code: "device-code", user_code: "MOCK-CODE", verification_uri: "https://example.invalid/activate", expires_in: 600, interval: 1 });
    }
    if (url.pathname === "/oauth2/token" && req.method === "POST") {
      if (scenario === "authorization-pending") return sendJson(res, 400, { error: "authorization_pending" });
      if (scenario === "token-expired") return sendJson(res, 400, { error: "expired_token" });
      return sendJson(res, 200, { access_token: "mock-access-token", refresh_token: "mock-refresh-token", expires_in: 3600, scope: ["channel:read:subscriptions"], token_type: "bearer" });
    }
    if (url.pathname === "/oauth2/validate" && req.method === "GET") {
      return sendJson(res, 200, { client_id: "mock-client", login: "mock-user", user_id: "user-1", scopes: ["channel:read:subscriptions"], expires_in: 3600 });
    }
    if (url.pathname === "/helix/users" && req.method === "GET") {
      return sendJson(res, 200, { data: [{ id: "user-1", login: "mock-user", display_name: "Mock User" }] });
    }
    if (url.pathname === "/helix/eventsub/subscriptions") {
      if (req.method === "POST") {
        const body = await readJson(req);
        const item = { id: `sub-${subscriptions.length + 1}`, status: "enabled", ...body };
        subscriptions.push(item);
        return sendJson(res, 202, { data: [item], total: subscriptions.length });
      }
      if (req.method === "GET") return sendJson(res, 200, { data: subscriptions, total: subscriptions.length });
    }
    return sendJson(res, 404, { error: "not found" });
  });
  const wss = new WebSocketServer({ server, path: "/eventsub" });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    const session = { id: "session-1", status: "connected", keepalive_timeout_seconds: 10, reconnect_url: null };
    socket.send(JSON.stringify(envelope("session_welcome", { session })));
    if (scenario === "reconnect") {
      socket.send(JSON.stringify(envelope("session_reconnect", { session: { ...session, reconnect_url: wsUrl } })));
    } else if (scenario === "revoked") {
      socket.send(JSON.stringify(envelope("revocation", { subscription: { id: "sub-1", status: "authorization_revoked", type: "channel.subscribe", version: "1" } })));
    } else {
      socket.send(JSON.stringify(envelope("notification", {
        subscription: { id: "sub-1", status: "enabled", type: "channel.subscribe", version: "1" },
        event: { user_id: "viewer-1", user_name: "MockViewer", broadcaster_user_id: "user-1", tier: "1000", is_gift: false },
      })));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://${options.host ?? "127.0.0.1"}:${address.port}`;
  wsUrl = origin.replace(/^http/, "ws") + "/eventsub";
  return {
    origin,
    url: wsUrl,
    subscriptions,
    get scenario() { return scenario; },
    setScenario(next) {
      if (!EVENTSUB_SCENARIOS.includes(next)) throw new Error(`eventsub: unknown scenario ${next}`);
      scenario = next;
    },
    async close() {
      for (const client of clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
