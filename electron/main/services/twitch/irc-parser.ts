function decode(value: string): string { const replacements: Record<string, string> = { s: " ", ":": ";", r: "\r", n: "\n", "\\": "\\" }; return value.replace(/\\([s:r n\\])/g, (_, code) => replacements[code] ?? code); }

export function parseIrcFrame(frame: string): Array<Record<string, any>> {
  return String(frame ?? "").split("\n").map((line) => {
    let rest = line.replace(/\r$/, ""); const tags: Record<string, string> = {};
    if (rest.startsWith("@")) { const end = rest.indexOf(" "); if (end < 0) return null; for (const part of rest.slice(1, end).split(";")) { const [key, value = ""] = part.split("=", 2); tags[key] = decode(value); } rest = rest.slice(end + 1); }
    let prefix = ""; if (rest.startsWith(":")) { const end = rest.indexOf(" "); if (end < 0) return null; prefix = rest.slice(1, end); rest = rest.slice(end + 1); }
    const [head, trailing = ""] = rest.split(/\s+:/, 2); const parts = head.trim().split(/\s+/).filter(Boolean); const command = parts.shift()?.toUpperCase(); if (!command) return null;
    const channel = parts.find((part) => part.startsWith("#"))?.replace(/^#/, "").toLowerCase() ?? ""; const login = prefix.split("!")[0].toLowerCase();
    if (command === "PING") return { type: "ping", payload: trailing ? `:${trailing}` : (parts[0] ?? "") };
    if (command === "RECONNECT") return { type: "reconnect" };
    // "bits" tag (issue #177): see src/twitch-chat/twitch-chat-session.js's identical forwarding
    // for why this is threaded through — a real cheer's own chat message carries it.
    if (command === "PRIVMSG" && channel && trailing) return { type: "privmsg", author: tags["display-name"] || login, channel, text: trailing, emotes: tags.emotes ?? null, bits: tags.bits ? Number(tags.bits) : null };
    return { type: command === "NOTICE" ? "notice" : "unknown" };
  }).filter(Boolean) as Array<Record<string, any>>;
}
