import path from "node:path";
import { PublicIpcError, type PublicErrorCode } from "../../../shared/errors";
import { OVERLAY_ASSET_LIMITS, type OverlayAssetKind } from "../../../shared/overlay-asset-contract";

export type ValidatedOverlayAsset = { kind: OverlayAssetKind; mimeType: string; extension: string; image?: { width: number; height: number; animated: boolean }; audio?: {} };

function invalid(code: PublicErrorCode, message: string): never { throw new PublicIpcError(code, message); }
function u16le(b: Buffer, o: number): number { return b.readUInt16LE(o); }
function u24le(b: Buffer, o: number): number { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return null;
}

function detectImage(bytes: Buffer): Omit<ValidatedOverlayAsset, "kind"> | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mimeType: "image/png", extension: "png", image: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), animated: bytes.includes(Buffer.from("acTL")) } };
  if (bytes.length >= 10 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return { mimeType: "image/gif", extension: "gif", image: { width: u16le(bytes, 6), height: u16le(bytes, 8), animated: bytes.indexOf(Buffer.from([0x21,0xff,0x0b])) >= 0 } };
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) { const size = jpegSize(bytes); return size ? { mimeType: "image/jpeg", extension: "jpg", image: { ...size, animated: false } } : null; }
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = bytes.subarray(12, 16).toString("ascii"); let width = 0; let height = 0; let animated = bytes.includes(Buffer.from("ANIM"));
    if (chunk === "VP8X") { width = u24le(bytes, 24) + 1; height = u24le(bytes, 27) + 1; animated ||= Boolean(bytes[20] & 2); }
    else if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    else if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    if (width && height) return { mimeType: "image/webp", extension: "webp", image: { width, height, animated } };
  }
  return null;
}

function detectAudio(bytes: Buffer): Omit<ValidatedOverlayAsset, "kind"> | null {
  if (validWav(bytes)) return { mimeType: "audio/wav", extension: "wav", audio: {} };
  if (validOggVorbis(bytes)) return { mimeType: "audio/ogg", extension: "ogg", audio: {} };
  if (validMpegAudioFrame(bytes, 0)) return { mimeType: "audio/mpeg", extension: "mp3", audio: {} };
  if (bytes.length >= 14 && bytes.subarray(0, 3).toString("ascii") === "ID3") {
    if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => value & 0x80)) return null;
    const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f); const frame = 10 + tagSize;
    if (validMpegAudioFrame(bytes, frame)) return { mimeType: "audio/mpeg", extension: "mp3", audio: {} };
  }
  return null;
}

function validWav(bytes: Buffer): boolean {
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE" || bytes.readUInt32LE(4) + 8 > bytes.length) return false;
  let offset = 12; let format = false; let data = false;
  while (offset + 8 <= bytes.length) { const id = bytes.subarray(offset, offset + 4).toString("ascii"); const size = bytes.readUInt32LE(offset + 4); const start = offset + 8; const end = start + size; if (end > bytes.length) return false;
    if (id === "fmt ") { if (size < 16) return false; const encoding = bytes.readUInt16LE(start); const channels = bytes.readUInt16LE(start + 2); const sampleRate = bytes.readUInt32LE(start + 4); const bits = bytes.readUInt16LE(start + 14); if (![1, 3, 0xfffe].includes(encoding) || channels < 1 || channels > 8 || sampleRate < 8_000 || sampleRate > 384_000 || ![8, 16, 24, 32, 64].includes(bits)) return false; format = true; }
    if (id === "data") { if (size === 0) return false; data = true; } offset = end + (size % 2); }
  return format && data;
}

function validOggVorbis(bytes: Buffer): boolean {
  if (bytes.length < 35 || bytes.subarray(0, 4).toString("ascii") !== "OggS" || bytes[4] !== 0 || (bytes[5] & 0x02) === 0) return false;
  const segments = bytes[26]; if (segments < 1 || 27 + segments > bytes.length) return false; let packetSize = 0; let complete = false;
  for (let i = 0; i < segments; i += 1) { packetSize += bytes[27 + i]; if (bytes[27 + i] < 255) { complete = true; break; } }
  const packet = 27 + segments; return complete && packetSize >= 30 && packet + packetSize <= bytes.length && bytes[packet] === 1 && bytes.subarray(packet + 1, packet + 7).toString("ascii") === "vorbis";
}

function validMpegAudioFrame(bytes: Buffer, offset: number): boolean {
  if (offset < 0 || offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[offset + 1] >> 3) & 3; const layer = (bytes[offset + 1] >> 1) & 3; const bitrate = (bytes[offset + 2] >> 4) & 15; const sampleRate = (bytes[offset + 2] >> 2) & 3; const emphasis = bytes[offset + 3] & 3;
  return version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3 && emphasis !== 2;
}

export function sanitizeOverlayAssetDisplayName(value: string): string {
  const cleaned = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, OVERLAY_ASSET_LIMITS.maxDisplayNameChars);
  return cleaned || "asset";
}

export function validateOverlayAssetBytes(bytes: Buffer, expectedKind?: OverlayAssetKind): ValidatedOverlayAsset {
  const detected = detectImage(bytes) ?? detectAudio(bytes);
  if (!detected) invalid("UNSUPPORTED_FORMAT", "対応していない、または破損したアセット形式です");
  const kind: OverlayAssetKind = detected.image ? "image" : "audio";
  if (expectedKind && expectedKind !== kind) invalid("MIME_MISMATCH", "選択した種類とファイル内容が一致しません");
  const max = kind === "image" ? OVERLAY_ASSET_LIMITS.imageBytes : OVERLAY_ASSET_LIMITS.audioBytes;
  if (bytes.byteLength > max) invalid("ASSET_OVERSIZE", "アセットのファイルサイズが上限を超えています");
  if (detected.image && (detected.image.width < 1 || detected.image.height < 1)) invalid("DECODE_FAILED", "画像寸法を取得できません");
  if (detected.image && (detected.image.width > OVERLAY_ASSET_LIMITS.maxDimension || detected.image.height > OVERLAY_ASSET_LIMITS.maxDimension)) invalid("DIMENSION_OVERSIZE", "画像寸法が上限を超えています");
  return { kind, ...detected };
}
