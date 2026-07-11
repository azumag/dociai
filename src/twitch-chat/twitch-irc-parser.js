function normalizeChannel(channel) { return String(channel ?? "").replace(/^#/, "").toLowerCase(); }

export function decodeIrcTag(value) {
  let output = "";
  for (let index = 0; index < String(value ?? "").length; index += 1) {
    const current = value[index];
    if (current !== "\\") { output += current; continue; }
    const next = value[index += 1];
    output += ({ s: " ", ":": ";", r: "\r", n: "\n", "\\": "\\" })[next] ?? (next ?? "");
  }
  return output;
}

export function parseIrcTags(raw) {
  const tags = {};
  for (const part of String(raw ?? "").split(";")) {
    const separator = part.indexOf("=");
    const key = separator < 0 ? part : part.slice(0, separator);
    if (key) tags[key] = decodeIrcTag(separator < 0 ? "" : part.slice(separator + 1));
  }
  return tags;
}

function parseLine(rawLine) {
  let rest = String(rawLine ?? "").replace(/\r$/, "").trim();
  if (!rest) return null;
  let tags = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return { type: "malformed" };
    tags = parseIrcTags(rest.slice(1, end));
    rest = rest.slice(end + 1);
  }
  let prefix = "";
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 0) return { type: "malformed" };
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  const [head, trailing = ""] = rest.split(/\s+:/, 2);
  const parts = head.trim().split(/\s+/).filter(Boolean);
  const command = parts.shift()?.toUpperCase();
  if (!command) return { type: "malformed" };
  const params = parts;
  const login = prefix.split("!")[0].toLowerCase();
  const channel = normalizeChannel(params.find((part) => part.startsWith("#")));
  if (command === "PING") return { type: "ping", payload: trailing ? `:${trailing}` : (params[0] ?? "") };
  if (command === "RECONNECT") return { type: "reconnect" };
  if (command === "PRIVMSG" && channel && trailing) return { type: "privmsg", login, author: tags["display-name"] || login, channel, text: trailing, emotes: tags.emotes || null, tags };
  if (command === "JOIN" && channel) return { type: "join", login, channel, tags };
  if (command === "PART" && channel) return { type: "part", login, channel, tags };
  if (command === "NOTICE") return { type: "notice", channel, message: trailing, messageId: tags["msg-id"] ?? null, tags };
  if (command === "ROOMSTATE" && channel) return { type: "roomstate", channel, tags };
  if (/^\d{3}$/.test(command)) return { type: "numeric", code: Number(command), params, message: trailing, tags };
  return { type: "unknown", command, params, tags };
}

export function parseIrcFrame(frame) {
  const events = [];
  for (const line of String(frame ?? "").split("\n")) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return events;
}
