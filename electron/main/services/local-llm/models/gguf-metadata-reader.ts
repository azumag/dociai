// Minimal GGUF header reader (#75). This is intentionally NOT a full GGUF parser — just enough
// to (a) verify the magic bytes so garbage files are rejected before being treated as models, and
// (b) best-effort pull a couple of basic metadata fields (general.architecture, general.name)
// when they are easy to reach within the first MAX_READ_BYTES of the file.
//
// GGUF binary layout (https://github.com/ggml-org/ggml/blob/master/docs/gguf.md):
//   uint32  magic        ASCII "GGUF" (0x47475546 as a little-endian uint32)
//   uint32  version
//   uint64  tensor_count
//   uint64  metadata_kv_count
//   ...then metadata_kv_count key/value pairs (string key, uint32 type, then a type-tagged value)
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";

export type GgufHeaderResult =
  | {
      valid: true;
      version: number;
      tensorCount: number;
      kvCount: number;
      architecture?: string;
      name?: string;
      // Numeric architecture fields (#78's planning layer needs these for KV-cache/context-fit
      // estimation — see electron/main/services/local-llm/planning/fit-estimator.ts). Named after
      // the raw GGUF key's own tail segment (e.g. "{architecture}.context_length"), not the
      // planning layer's own FitModelInput field names, since more than one consumer may want
      // these eventually. Absent when the corresponding KV entry isn't present/reachable within
      // this best-effort scan — never defaulted to 0 here, so a caller can tell "field genuinely
      // missing" apart from "field is legitimately zero".
      contextLength?: number;
      embeddingLength?: number;
      blockCount?: number;
      attentionHeadCount?: number;
      attentionHeadCountKv?: number;
      feedForwardLength?: number;
    }
  | { valid: false; reason: string };

const MAGIC_BYTES = "GGUF";
const HEADER_MIN_BYTES = 4 + 4 + 8 + 8; // magic + version + tensor_count + kv_count
const MAX_READ_BYTES = 1_048_576; // 1 MiB: header + a modest number of KV entries, never the tensors themselves
const MAX_KV_ENTRIES_TO_SCAN = 64;
const MAX_STRING_BYTES = 4_096;
const MAX_ARRAY_ELEMENTS_TO_SKIP = 10_000;

const GGUF_TYPE = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7,
  STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
} as const;
const FIXED_WIDTH_BY_TYPE: Record<number, number> = {
  [GGUF_TYPE.UINT8]: 1, [GGUF_TYPE.INT8]: 1, [GGUF_TYPE.UINT16]: 2, [GGUF_TYPE.INT16]: 2,
  [GGUF_TYPE.UINT32]: 4, [GGUF_TYPE.INT32]: 4, [GGUF_TYPE.FLOAT32]: 4, [GGUF_TYPE.BOOL]: 1,
  [GGUF_TYPE.UINT64]: 8, [GGUF_TYPE.INT64]: 8, [GGUF_TYPE.FLOAT64]: 8,
};

function safeNumberFromUint64LE(data: Buffer, offset: number): number {
  const value = data.readBigUInt64LE(offset);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function safeNumberFromInt64LE(data: Buffer, offset: number): number {
  const value = data.readBigInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (value < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
  return Number(value);
}

/** Reads a single FIXED-WIDTH scalar value (every GGUF_TYPE except STRING/ARRAY, which have their
 * own readers above/below) at `offset`, returning its JS value plus the offset just past it. Used
 * by readGgufKv() so numeric architecture fields (block_count, context_length, attention.head_
 * count, ...) are actually captured rather than only skipped-past — see this reader's extended
 * GgufHeaderResult fields, added for #78's planning layer. Returns null on a truncated buffer or
 * an unrecognized type, same "stop scanning, don't throw" contract as skipGgufValue(). */
function readGgufScalar(data: Buffer, offset: number, type: number): { value: number | boolean; next: number } | null {
  switch (type) {
    case GGUF_TYPE.UINT8: return offset + 1 <= data.length ? { value: data.readUInt8(offset), next: offset + 1 } : null;
    case GGUF_TYPE.INT8: return offset + 1 <= data.length ? { value: data.readInt8(offset), next: offset + 1 } : null;
    case GGUF_TYPE.BOOL: return offset + 1 <= data.length ? { value: data.readUInt8(offset) !== 0, next: offset + 1 } : null;
    case GGUF_TYPE.UINT16: return offset + 2 <= data.length ? { value: data.readUInt16LE(offset), next: offset + 2 } : null;
    case GGUF_TYPE.INT16: return offset + 2 <= data.length ? { value: data.readInt16LE(offset), next: offset + 2 } : null;
    case GGUF_TYPE.UINT32: return offset + 4 <= data.length ? { value: data.readUInt32LE(offset), next: offset + 4 } : null;
    case GGUF_TYPE.INT32: return offset + 4 <= data.length ? { value: data.readInt32LE(offset), next: offset + 4 } : null;
    case GGUF_TYPE.FLOAT32: return offset + 4 <= data.length ? { value: data.readFloatLE(offset), next: offset + 4 } : null;
    case GGUF_TYPE.UINT64: return offset + 8 <= data.length ? { value: safeNumberFromUint64LE(data, offset), next: offset + 8 } : null;
    case GGUF_TYPE.INT64: return offset + 8 <= data.length ? { value: safeNumberFromInt64LE(data, offset), next: offset + 8 } : null;
    case GGUF_TYPE.FLOAT64: return offset + 8 <= data.length ? { value: data.readDoubleLE(offset), next: offset + 8 } : null;
    default: return null;
  }
}

function readGgufString(data: Buffer, offset: number): { value: string; next: number } | null {
  if (offset + 8 > data.length) return null;
  const length = safeNumberFromUint64LE(data, offset);
  const start = offset + 8;
  if (length < 0 || length > MAX_STRING_BYTES || start + length > data.length) return null;
  return { value: data.toString("utf8", start, start + length), next: start + length };
}

/** Advances past a value of `type` at `offset` without interpreting it (beyond strings/arrays,
 * which must be walked to know their true length). Returns null when the value cannot be safely
 * skipped (truncated buffer, unknown type, or an absurd array length) — callers must stop
 * scanning further KV entries in that case, since the true offset is no longer knowable. */
function skipGgufValue(data: Buffer, offset: number, type: number): number | null {
  if (type === GGUF_TYPE.STRING) {
    const result = readGgufString(data, offset);
    return result ? result.next : null;
  }
  if (type === GGUF_TYPE.ARRAY) {
    if (offset + 4 + 8 > data.length) return null;
    const elementType = data.readUInt32LE(offset);
    const count = safeNumberFromUint64LE(data, offset + 4);
    if (count < 0 || count > MAX_ARRAY_ELEMENTS_TO_SKIP) return null;
    let cursor = offset + 12;
    for (let index = 0; index < count; index += 1) {
      const next = skipGgufValue(data, cursor, elementType);
      if (next === null) return null;
      cursor = next;
    }
    return cursor;
  }
  const width = FIXED_WIDTH_BY_TYPE[type];
  if (width === undefined) return null;
  return offset + width <= data.length ? offset + width : null;
}

function readGgufKv(data: Buffer, offset: number): { key: string; value: string | number | boolean | undefined; next: number } | null {
  const key = readGgufString(data, offset);
  if (!key) return null;
  if (key.next + 4 > data.length) return null;
  const type = data.readUInt32LE(key.next);
  const valueOffset = key.next + 4;
  if (type === GGUF_TYPE.STRING) {
    const value = readGgufString(data, valueOffset);
    if (!value) return null;
    return { key: key.value, value: value.value, next: value.next };
  }
  if (type !== GGUF_TYPE.ARRAY) {
    // Every non-string, non-array GGUF_TYPE is a fixed-width scalar readGgufScalar() understands;
    // a null here means truncation, not "this type has no scalar reader".
    const scalar = readGgufScalar(data, valueOffset, type);
    if (!scalar) return null;
    return { key: key.value, value: scalar.value, next: scalar.next };
  }
  const next = skipGgufValue(data, valueOffset, type);
  if (next === null) return null;
  return { key: key.value, value: undefined, next };
}

/** Reads and validates only the GGUF header (never the tensor payload). Rejects files that are
 * too small or whose magic bytes do not match; best-effort extracts general.architecture /
 * general.name when present in the scanned prefix. */
export async function readGgufHeader(filePath: string): Promise<GgufHeaderResult> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < HEADER_MIN_BYTES) return { valid: false, reason: "file is smaller than the GGUF header" };
    const bufferSize = Math.min(MAX_READ_BYTES, stat.size);
    const buffer = Buffer.alloc(bufferSize);
    const { bytesRead } = await handle.read(buffer, 0, bufferSize, 0);
    const data = buffer.subarray(0, bytesRead);
    if (data.length < HEADER_MIN_BYTES) return { valid: false, reason: "file is smaller than the GGUF header" };

    const magic = data.toString("ascii", 0, 4);
    if (magic !== MAGIC_BYTES) return { valid: false, reason: `invalid GGUF magic bytes: ${JSON.stringify(magic)}` };

    let offset = 4;
    const version = data.readUInt32LE(offset); offset += 4;
    const tensorCount = safeNumberFromUint64LE(data, offset); offset += 8;
    const kvCount = safeNumberFromUint64LE(data, offset); offset += 8;

    const metadata: {
      architecture?: string;
      name?: string;
      contextLength?: number;
      embeddingLength?: number;
      blockCount?: number;
      attentionHeadCount?: number;
      attentionHeadCountKv?: number;
      feedForwardLength?: number;
    } = {};
    const kvLimit = Math.min(kvCount, MAX_KV_ENTRIES_TO_SCAN);
    for (let index = 0; index < kvLimit; index += 1) {
      const entry = readGgufKv(data, offset);
      if (!entry) break; // best-effort only: stop scanning rather than throwing on an unreachable KV entry
      offset = entry.next;
      if (entry.key === "general.architecture" && typeof entry.value === "string") metadata.architecture = entry.value;
      if (entry.key === "general.name" && typeof entry.value === "string") metadata.name = entry.value;
      // Architecture-prefixed numeric fields (raw key is "{architecture}.<suffix>", e.g.
      // "llama.attention.head_count_kv") — matched by suffix rather than requiring
      // general.architecture to have already been seen in this same linear scan, since KV entry
      // order within a GGUF file is not a guaranteed contract. Suffixes are precise enough (no
      // architecture defines a KV key ending in these exact strings for anything else) that no
      // architecture-prefix confirmation is needed. head_count_kv is checked before head_count so
      // the more specific suffix always wins, even though the two can never actually collide
      // (".head_count_kv" and ".head_count" cannot both match the same trailing characters).
      if (typeof entry.value === "number") {
        if (entry.key.endsWith(".context_length")) metadata.contextLength = entry.value;
        else if (entry.key.endsWith(".embedding_length")) metadata.embeddingLength = entry.value;
        else if (entry.key.endsWith(".block_count")) metadata.blockCount = entry.value;
        else if (entry.key.endsWith(".attention.head_count_kv")) metadata.attentionHeadCountKv = entry.value;
        else if (entry.key.endsWith(".attention.head_count")) metadata.attentionHeadCount = entry.value;
        else if (entry.key.endsWith(".feed_forward_length")) metadata.feedForwardLength = entry.value;
      }
    }

    return { valid: true, version, tensorCount, kvCount, ...metadata };
  } finally {
    await handle.close();
  }
}

/** Streams the full file through sha256 so hashing multi-gigabyte model files never loads them
 * into memory at once. */
export async function computeSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}
