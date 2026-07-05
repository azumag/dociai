import assert from "node:assert/strict";
import { validateConfig } from "../src/config-loader.js";
import { createConnector } from "../src/connectors.js";

const config = {
  connectors: {
    minimax_main: {
      provider: "minimax",
      apiKey: "sk-test",
      model: "MiniMax-M3",
    },
  },
  personas: [
    {
      id: "minimax_ai",
      name: "MiniMax AI",
      connector: "minimax_main",
      systemPrompt: "短く返します。",
    },
  ],
  triggers: {
    manual: { type: "manual" },
  },
};

const validation = validateConfig(config);
assert.deepEqual(validation.errors, []);
assert.deepEqual(validation.warnings, []);

const connector = createConnector("minimax_main", config.connectors.minimax_main);
assert.equal(connector.describe().provider, "minimax");
assert.equal(connector.describe().model, "MiniMax-M3");

let request;
globalThis.fetch = async (url, init) => {
  request = { url, init, body: JSON.parse(init.body) };
  return {
    ok: true,
    json: async () => ({
      content: [{ type: "text", text: "画像を確認しました。" }],
      usage: { input_tokens: 12, output_tokens: 5 },
    }),
  };
};

const image = "data:image/png;base64,iVBORw0KGgo=";
const result = await connector.chat([
  { role: "system", content: "画面を説明してください。" },
  {
    role: "user",
    content: [
      { type: "text", text: "何が見えますか。" },
      { type: "image_url", image_url: { url: image } },
    ],
  },
], { maxTokens: 128 });

assert.equal(result.text, "画像を確認しました。");
assert.equal(request.url, "https://api.minimax.io/anthropic/v1/messages");
assert.equal(request.init.headers["x-api-key"], "sk-test");
assert.equal(request.init.headers["anthropic-version"], "2023-06-01");
assert.equal(request.body.model, "MiniMax-M3");
assert.equal(request.body.max_tokens, 128);
assert.equal(request.body.system, "画面を説明してください。");
assert.deepEqual(request.body.messages[0].content, [
  { type: "text", text: "何が見えますか。" },
  {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "iVBORw0KGgo=",
    },
  },
]);

console.log("PASS | minimax provider");
