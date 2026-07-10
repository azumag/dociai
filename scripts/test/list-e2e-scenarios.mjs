const scenarios = [
  ["browser", "npm run test:e2e:browser", "isolated workspace + managed Chromium"],
  ["browser-direct", "npm run test:e2e:browser:direct", "requires an already running local server"],
  ["settings", "npm --workspace e2e run test:settings", "settings editor persistence"],
  ["twitch", "npm --workspace e2e run test:twitch", "Twitch comment source"],
  ["voicevox", "npm --workspace e2e run test:voicevox", "VOICEVOX chunk queue"],
  ["bouyomi", "npm --workspace e2e run test:bouyomi", "Bouyomi integration"],
  ["crosstab", "npm --workspace e2e run test:crosstab", "headed cross-tab OBS transport"],
];

for (const [name, command, description] of scenarios) {
  console.log(`${name.padEnd(16)} ${command.padEnd(46)} ${description}`);
}
