import { createServer } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

export function send(res, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": payload.byteLength,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8", headers);
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: { message, status } });
}

export async function startHttpMock({ name, scenarios, initialScenario = "success", handler, host = "127.0.0.1", port = 0 }) {
  if (!scenarios.includes(initialScenario)) throw new Error(`${name}: unknown initial scenario ${initialScenario}`);
  let currentScenario = initialScenario;
  const sockets = new Set();
  const stats = { requests: 0, aborted: 0 };

  const server = createServer(async (req, res) => {
    stats.requests += 1;
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      if (url.pathname === "/__ready") {
        sendJson(res, 200, { ok: true, name, scenario: currentScenario });
        return;
      }
      if (url.pathname === "/__scenario") {
        if (req.method === "GET") {
          sendJson(res, 200, { scenario: currentScenario, scenarios });
          return;
        }
        if (req.method === "PUT") {
          const { scenario } = await readJson(req);
          if (!scenarios.includes(scenario)) {
            sendJson(res, 400, { error: `unknown scenario: ${scenario}`, scenarios });
            return;
          }
          currentScenario = scenario;
          sendJson(res, 200, { scenario: currentScenario });
          return;
        }
      }

      const requested = req.headers["x-dociai-scenario"];
      const scenario = typeof requested === "string" ? requested : currentScenario;
      if (!scenarios.includes(scenario)) {
        sendJson(res, 400, { error: `unknown scenario: ${scenario}`, scenarios });
        return;
      }
      const hang = () => new Promise((resolve) => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          stats.aborted += 1;
          resolve();
        };
        req.once("aborted", done);
        res.once("close", done);
      });
      await handler({ req, res, url, scenario, stats, hang });
    } catch (error) {
      if (!res.headersSent) sendError(res, error.status ?? 500, error.message ?? "mock server error");
      else res.destroy(error);
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const origin = `http://${host}:${address.port}`;

  return {
    name,
    server,
    origin,
    url: origin,
    stats,
    get scenario() { return currentScenario; },
    setScenario(scenario) {
      if (!scenarios.includes(scenario)) throw new Error(`${name}: unknown scenario ${scenario}`);
      currentScenario = scenario;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
