const dedupe = (values) => [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
export function normalizeConfig(config) {
  const copy = structuredClone(config);
  for (const persona of copy.personas ?? []) { persona.id = String(persona.id ?? "").trim(); persona.triggers = dedupe(persona.triggers); }
  const twitch = copy.commentSources?.twitch;
  if (twitch) twitch.channels = dedupe(twitch.channels).map((channel) => channel.toLowerCase().replace(/^#/, ""));
  for (const source of [...(copy.news?.sources ?? []), ...(copy.topics?.sources ?? [])]) if (source?.name) source.name = String(source.name).trim();
  if (copy.topics) copy.topics.personas = dedupe(copy.topics.personas);
  return copy;
}
