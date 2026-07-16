// SpokenTextSanitizer (issue #192)
// 音声本文からtool/API失敗文、markdown、URL、制御文字、marker残骸、内部事情の吐露を除去する。
// sanitize後に意味が壊れる場合はここでは判定せず、呼び出し側 (quality gate) がrewriteへ回す。

const INTERNAL_LEAK_PATTERNS = [
  { pattern: /web\s*fetch/i, code: "internal_leak_tool" },
  { pattern: /web\s*search/i, code: "internal_leak_tool" },
  { pattern: /\btool\b/i, code: "internal_leak_tool" },
  { pattern: /rate\s*limit/i, code: "internal_leak_error" },
  { pattern: /stack\s*trace/i, code: "internal_leak_error" },
  { pattern: /json\s*(parse)?\s*error/i, code: "internal_leak_error" },
  { pattern: /https?\s*status\s*\d{3}/i, code: "internal_leak_error" },
  { pattern: /検索(が|に)?できませんでした/, code: "internal_leak_apology" },
  { pattern: /指示に従えません/, code: "internal_leak_apology" },
  { pattern: /system\s*prompt/i, code: "internal_leak_prompt" },
  { pattern: /as an ai(\s*language\s*model)?/i, code: "internal_leak_prompt" },
];

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
}

function stripUrls(text) {
  return text.replace(/https?:\/\/\S+/g, "");
}

// C0/C1制御文字 (タブ\t・改行\nは除く) とANSIエスケープ (色コード等、\x1bで始まる制御シーケンス)
// を除去する。文字コードを直接比較し、ソースファイルへ生の制御バイトを書き込まない。
function stripControlChars(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const isTabOrNewline = code === 0x09 || code === 0x0a || code === 0x0d;
    const isControl = (code <= 0x1f && !isTabOrNewline) || code === 0x7f;
    if (!isControl) out += ch;
  }
  // 上のループで\x1b (ESC) 自体は既に除去済みなので、ここでは後続の "[31m" のような
  // 残骸だけを取り除けばよい。
  return out.replace(/\[[0-9;]*m/g, "");
}

function stripMarkerResidue(text) {
  return text.replace(/===[A-Z_]+===/g, "");
}

function removeInternalLeaks(text, warnings) {
  let out = text;
  for (const { pattern, code } of INTERNAL_LEAK_PATTERNS) {
    if (pattern.test(out)) {
      warnings.push(code);
      const sentenceStripper = new RegExp(`[^。\n]*${pattern.source}[^。\n]*[。]?`, pattern.flags.includes("i") ? "gi" : "g");
      out = out.replace(sentenceStripper, "");
    }
  }
  return out;
}

// 同一の前置き・締めの文が連続するのは反復検査(repetition-detector)側の責務。ここでは
// 明らかな文字レベルの汚染だけを機械的に取り除く。
export function sanitizeSpokenText(rawText) {
  const warnings = [];
  let text = String(rawText ?? "");
  text = stripMarkerResidue(text);
  text = stripMarkdown(text);
  text = stripUrls(text);
  text = stripControlChars(text);
  text = removeInternalLeaks(text, warnings);
  text = text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { text, warnings };
}
