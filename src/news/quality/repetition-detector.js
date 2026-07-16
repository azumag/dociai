// RepetitionDetector (issue #192): 10字以上の同一文が3回以上、同一行3連続、
// 20文字以上chunkが5回以上、を検査する。

function splitSentences(text) {
  return text.split(/(?<=[。！？!?])\s*/).map((s) => s.trim()).filter(Boolean);
}

export function detectRepetition(text) {
  const failures = [];
  const sentences = splitSentences(text);
  const counts = new Map();
  for (const sentence of sentences) {
    if (sentence.length < 10) continue;
    counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  }
  let maxSentenceRepetition = 0;
  for (const [sentence, count] of counts) {
    maxSentenceRepetition = Math.max(maxSentenceRepetition, count);
    if (count >= 3) failures.push({ code: "sentence_repetition", detail: sentence, count });
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i + 2 < lines.length; i++) {
    if (lines[i] && lines[i] === lines[i + 1] && lines[i] === lines[i + 2]) {
      failures.push({ code: "line_repetition_3x", detail: lines[i] });
      break; // 同一箇所からの多重報告を避ける
    }
  }

  const chunkSize = 20;
  const chunkCounts = new Map();
  for (let i = 0; i + chunkSize <= text.length; i++) {
    const chunk = text.slice(i, i + chunkSize);
    chunkCounts.set(chunk, (chunkCounts.get(chunk) ?? 0) + 1);
  }
  for (const [chunk, count] of chunkCounts) {
    if (count >= 5) {
      failures.push({ code: "chunk_repetition", detail: chunk, count });
      break;
    }
  }

  return { maxSentenceRepetition, failures };
}
