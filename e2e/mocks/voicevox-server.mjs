import { readJson, send, sendError, sendJson, startHttpMock } from "./http-mock.mjs";

export const VOICEVOX_SCENARIOS = ["success", "delay", "500", "timeout", "cancel"];

const WAV = Buffer.from("524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000", "hex");

export function startVoicevoxServer(options = {}) {
  return startHttpMock({
    name: "voicevox",
    scenarios: VOICEVOX_SCENARIOS,
    initialScenario: options.scenario ?? "success",
    host: options.host,
    port: options.port,
    async handler({ req, res, url, scenario, hang }) {
      if (["timeout", "cancel"].includes(scenario)) return await hang();
      if (scenario === "500") return sendError(res, 500, "mock VOICEVOX failure");
      if (scenario === "delay") await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 100));
      if (url.pathname === "/speakers" && req.method === "GET") {
        return sendJson(res, 200, [{ name: "モック話者", speaker_uuid: "mock-speaker", styles: [{ id: 1, name: "ノーマル" }] }]);
      }
      if (url.pathname === "/audio_query" && req.method === "POST") {
        return sendJson(res, 200, { accent_phrases: [], speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1 });
      }
      if (url.pathname === "/synthesis" && req.method === "POST") {
        await readJson(req);
        return send(res, 200, WAV, "audio/wav");
      }
      return sendError(res, 404, "not found");
    },
  });
}
