import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("../..", import.meta.url).pathname);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function waitForProxy(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`proxy did not start: ${output}`)), 5000);
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(port);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/opencode-proxy: http:\/\/localhost:(\d+)/);
      if (match) finish(null, Number(match[1]));
    });
    child.stderr.resume();
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code !== 0) finish(new Error(`proxy exited before startup (code=${code}, signal=${signal}): ${output}`));
    });
  });
}

test("OpenCode proxy allows and forwards x-opencode-session", async () => {
  let request;
  const upstream = createServer((incoming, response) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      request = { method: incoming.method, url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  const upstreamPort = await listen(upstream);
  const child = spawn(process.env.PYTHON_BIN ?? "python3", ["scripts/opencode-proxy.py", "0"], {
    cwd: root,
    env: { ...process.env, OPENCODE_PROXY_UPSTREAM: `http://127.0.0.1:${upstreamPort}/v1` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const proxyPort = await waitForProxy(child);
    const endpoint = `http://127.0.0.1:${proxyPort}/chat/completions`;
    const preflight = await fetch(endpoint, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Headers": "content-type, x-opencode-session" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers")?.toLowerCase() ?? "", /x-opencode-session/);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test", "x-opencode-session": "session-fixture" },
      body: JSON.stringify({ model: "fixture" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { choices: [{ message: { content: "ok" } }] });
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test");
    assert.equal(request.headers["x-opencode-session"], "session-fixture");
    assert.equal(request.body, JSON.stringify({ model: "fixture" }));
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    }
    await close(upstream);
  }
});
