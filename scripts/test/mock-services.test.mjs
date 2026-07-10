import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { startAiServer } from "../../e2e/mocks/ai-server.mjs";
import { startBouyomiServer } from "../../e2e/mocks/bouyomi-server.mjs";
import { startEventsubServer } from "../../e2e/mocks/eventsub-server.mjs";
import { startRssServer } from "../../e2e/mocks/rss-server.mjs";
import { startTodoistServer } from "../../e2e/mocks/todoist-server.mjs";
import { startTwitchIrcServer } from "../../e2e/mocks/twitch-irc-server.mjs";
import { startVoicevoxServer } from "../../e2e/mocks/voicevox-server.mjs";

async function setScenario(mock, scenario) {
  const response = await fetch(`${mock.origin}/__scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario }),
  });
  assert.equal(response.status, 200);
}

function collectMessages(url, count, send) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = [];
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} WebSocket messages`)), 2_000);
    socket.on("open", () => send?.(socket));
    socket.on("message", (data) => {
      messages.push(data.toString());
      if (messages.length >= count) {
        clearTimeout(timer);
        socket.close();
        resolve(messages);
      }
    });
    socket.on("error", reject);
  });
}

test("HTTP scenario mocks provide success, pagination, errors, timeout, and speech payloads", async () => {
  const mocks = await Promise.all([
    startAiServer(),
    startRssServer(),
    startTodoistServer(),
    startVoicevoxServer(),
    startBouyomiServer(),
  ]);
  const [ai, rss, todoist, voicevox, bouyomi] = mocks;
  try {
    assert.equal(new Set(mocks.map((mock) => new URL(mock.origin).port)).size, mocks.length, "ephemeral ports must not collide");
    for (const mock of mocks) assert.equal((await fetch(`${mock.origin}/__ready`)).status, 200);

    const completion = await fetch(`${ai.origin}/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal((await completion.json()).choices[0].message.content, "モック応答");
    const stream = await fetch(`${ai.origin}/v1/chat/completions`, { method: "POST", headers: { "x-dociai-scenario": "stream" }, body: "{}" });
    assert.match(await stream.text(), /モック.*応答/s);
    await setScenario(ai, "429");
    assert.equal((await fetch(`${ai.origin}/v1/chat/completions`, { method: "POST", body: "{}" })).status, 429);
    ai.setScenario("timeout");
    await assert.rejects(fetch(`${ai.origin}/v1/chat/completions`, { method: "POST", body: "{}", signal: AbortSignal.timeout(50) }));

    assert.match(await (await fetch(`${rss.origin}/rss.xml`)).text(), /モックニュース1/);
    assert.match(await (await fetch(`${rss.origin}/atom.xml`)).text(), /モックAtom/);

    const firstPage = await fetch(`${todoist.origin}/rest/v2/tasks`);
    assert.equal(firstPage.headers.get("x-next-cursor"), "page-2");
    assert.equal((await firstPage.json()).length, 2);
    assert.equal((await (await fetch(`${todoist.origin}/rest/v2/tasks?cursor=page-2`)).json()).length, 1);

    assert.equal((await (await fetch(`${voicevox.origin}/speakers`)).json())[0].styles[0].id, 1);
    const query = await fetch(`${voicevox.origin}/audio_query?text=test&speaker=1`, { method: "POST" });
    const wav = await fetch(`${voicevox.origin}/synthesis?speaker=1`, { method: "POST", body: await query.text() });
    assert.equal(wav.headers.get("content-type"), "audio/wav");

    assert.equal((await fetch(`${bouyomi.origin}/Talk?text=test&voice=1`)).status, 200);
    assert.deepEqual(bouyomi.commands[0], { type: "Talk", text: "test", voice: 1 });
  } finally {
    await Promise.all(mocks.map((mock) => mock.close()));
  }
});

test("Twitch IRC and EventSub mocks expose protocol-level scenarios and cleanly close", async () => {
  const irc = await startTwitchIrcServer();
  const eventsub = await startEventsubServer();
  try {
    const ircMessages = await collectMessages(irc.url, 3, (socket) => {
      socket.send("NICK justinfan123\r\n");
      socket.send("JOIN #dociai\r\n");
    });
    assert.match(ircMessages.join(""), /001 mock/);
    assert.match(ircMessages.join(""), /PRIVMSG #dociai :モックコメント/);

    const eventMessages = (await collectMessages(eventsub.url, 2)).map(JSON.parse);
    assert.equal(eventMessages[0].metadata.message_type, "session_welcome");
    assert.equal(eventMessages[1].metadata.message_type, "notification");

    const device = await fetch(`${eventsub.origin}/oauth2/device`, { method: "POST" });
    assert.equal((await device.json()).user_code, "MOCK-CODE");
    const created = await fetch(`${eventsub.origin}/helix/eventsub/subscriptions`, { method: "POST", body: JSON.stringify({ type: "channel.subscribe", version: "1" }) });
    assert.equal(created.status, 202);
    await setScenario(eventsub, "authorization-pending");
    assert.equal((await fetch(`${eventsub.origin}/oauth2/token`, { method: "POST" })).status, 400);
  } finally {
    await Promise.all([irc.close(), eventsub.close()]);
  }
});
