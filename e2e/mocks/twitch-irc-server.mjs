import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { readJson, sendJson } from "./http-mock.mjs";

export const TWITCH_IRC_SCENARIOS = ["success", "ping", "auth-error", "reconnect", "disconnect"];

export async function startTwitchIrcServer(options = {}) {
  let scenario = options.scenario ?? "success";
  if (!TWITCH_IRC_SCENARIOS.includes(scenario)) throw new Error(`twitch-irc: unknown scenario ${scenario}`);
  const clients = new Set();
  const messages = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__ready") return sendJson(res, 200, { ok: true, name: "twitch-irc", scenario });
    if (url.pathname === "/__scenario" && req.method === "GET") return sendJson(res, 200, { scenario, scenarios: TWITCH_IRC_SCENARIOS });
    if (url.pathname === "/__scenario" && req.method === "PUT") {
      const body = await readJson(req);
      if (!TWITCH_IRC_SCENARIOS.includes(body.scenario)) return sendJson(res, 400, { error: "unknown scenario" });
      scenario = body.scenario;
      return sendJson(res, 200, { scenario });
    }
    return sendJson(res, 404, { error: "not found" });
  });
  const wss = new WebSocketServer({ server, path: "/irc" });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    if (scenario === "auth-error") {
      socket.send(":tmi.twitch.tv NOTICE * :Login authentication failed\r\n");
      socket.close(4003, "auth-error");
      return;
    }
    if (scenario === "reconnect") {
      socket.send(":tmi.twitch.tv RECONNECT\r\n");
      return;
    }
    if (scenario === "disconnect") {
      socket.close(1012, "mock-disconnect");
      return;
    }
    if (scenario === "ping") socket.send("PING :tmi.twitch.tv\r\n");
    socket.on("message", (data) => {
      const text = data.toString();
      messages.push(text);
      if (/^NICK /m.test(text)) socket.send(":tmi.twitch.tv 001 mock :Welcome\r\n");
      const channel = text.match(/^JOIN #(\S+)/m)?.[1];
      if (channel) {
        socket.send(`:mock!mock@mock.tmi.twitch.tv JOIN #${channel}\r\n`);
        socket.send(`@display-name=MockUser;id=message-1 :mock!mock@mock.tmi.twitch.tv PRIVMSG #${channel} :モックコメント\r\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://${options.host ?? "127.0.0.1"}:${address.port}`;
  return {
    origin,
    url: origin.replace(/^http/, "ws") + "/irc",
    messages,
    get scenario() { return scenario; },
    setScenario(next) {
      if (!TWITCH_IRC_SCENARIOS.includes(next)) throw new Error(`twitch-irc: unknown scenario ${next}`);
      scenario = next;
    },
    async close() {
      for (const client of clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
