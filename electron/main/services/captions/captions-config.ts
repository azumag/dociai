// config.captions (src/config/config-defaults.js の既定値) をCaptionSessionが使う形へ読み出す
// (issue #282)。起動時 (electron/main/index.ts) とCONFIG_SAVE時 (electron/main/ipc/register.ts)
// の両方から同じ関数を通すことで、「保存したのに再起動するまで効かない」ズレを作らない。
//
// ここでは値の妥当性検証はしない — 保存を止める検証は src/config/config-validation.js が持ち、
// このファイルは「壊れた値でもサービスが起動できる安全側の既定へ丸める」だけを担当する
// (config.jsonを手で壊された場合でも字幕以外の機能を巻き添えにしないため)。
import { DEFAULT_CAPTIONS_CONFIG, type CaptionsConfig } from "./caption-session";

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

const integer = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;

const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

// 固有名詞置換辞書。キー・値ともに文字列のエントリだけを、上限件数まで採用する。
const replacements = (value: unknown): Record<string, string> => {
  const entries = Object.entries(record(value)).filter(([from, to]) => typeof from === "string" && from.length > 0 && from.length <= 100 && typeof to === "string" && to.length <= 100);
  return Object.fromEntries(entries.slice(0, 100) as Array<[string, string]>);
};

export function readCaptionsConfig(config: Record<string, unknown>): CaptionsConfig {
  const captions = record(config.captions);
  const obs = record(captions.obs);
  return {
    enabled: captions.enabled === true,
    chromeExecutable: text(captions.chromeExecutable),
    // 0 = ephemeral port (OSに空きポートを選ばせる)。固定値を指定した場合だけ競合が明示エラーになる。
    workerPort: integer(captions.workerPort, DEFAULT_CAPTIONS_CONFIG.workerPort, 0, 65_535),
    obs: {
      host: text(obs.host, DEFAULT_CAPTIONS_CONFIG.obs.host),
      port: integer(obs.port, DEFAULT_CAPTIONS_CONFIG.obs.port, 1, 65_535),
      microphoneInputName: text(obs.microphoneInputName),
    },
    maxPending: integer(captions.maxPending, DEFAULT_CAPTIONS_CONFIG.maxPending, 1, 20),
    maxAgeMs: integer(captions.maxAgeMs, DEFAULT_CAPTIONS_CONFIG.maxAgeMs, 500, 60_000),
    maxCaptionChars: integer(captions.maxCaptionChars, DEFAULT_CAPTIONS_CONFIG.maxCaptionChars, 0, 500),
    replacements: replacements(captions.replacements),
    logCaptions: captions.logCaptions === true,
  };
}
