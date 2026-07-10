import { ServiceError } from "../service-error";
import type { FeedItem } from "../../../shared/services/feed-contract";

function decodeXml(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" })[entity] ?? entity);
}

function text(value: string): string { return decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }

function tag(block: string, name: string): string {
  const escaped = name.replace(/[:]/g, "\\:");
  const found = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)</${escaped}>`, "i").exec(block);
  return found ? text(found[1]) : "";
}

function atomLink(block: string): string {
  const found = /<link\b[^>]*\bhref=(?:"([^"]*)"|'([^']*)')[^>]*\/?\s*>/i.exec(block);
  return found ? decodeXml(found[1] ?? found[2] ?? "").trim() : "";
}

function date(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function blocks(xml: string, name: "item" | "entry"): string[] {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "gi"))].map((match) => match[1]);
}

export function parseFeedXml(xml: string, sourceName: string, sourceIndex: number): FeedItem[] {
  if (typeof xml !== "string" || xml.length === 0 || !/<(?:rss|feed)\b/i.test(xml) || !/<\/(?:rss|feed)>/i.test(xml)) throw new ServiceError("BAD_REQUEST", "feed XML is invalid", { serviceId: "feed", retryable: false });
  const items = blocks(xml, "item");
  const entries = items.length ? items : blocks(xml, "entry");
  if (!entries.length && /<(?:item|entry)\b/i.test(xml)) throw new ServiceError("BAD_REQUEST", "feed XML is invalid", { serviceId: "feed", retryable: false });
  return entries.map((block) => {
    const title = tag(block, "title");
    const link = tag(block, "link") || atomLink(block);
    const description = (tag(block, "description") || tag(block, "summary") || tag(block, "content")).slice(0, 300);
    const publishedAt = date(tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || tag(block, "dc:date"));
    const guid = tag(block, "guid") || tag(block, "id") || link || title;
    return { title, link, description, publishedAt, guid, sourceName, sourceIndex };
  }).filter((item) => item.title.length > 0);
}
