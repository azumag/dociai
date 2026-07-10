import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const roots = ["src", "scripts", "e2e", "electron"];
const extensions = new Set([".js", ".mjs", ".cjs"]);

async function collect(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test-results") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collect(absolute));
    else if (extensions.has(path.extname(entry.name))) result.push(absolute);
  }
  return result;
}

const files = (await Promise.all(roots.map((root) => collect(path.join(repoRoot, root))))).flat().sort();
for (const file of files) {
  await execFileAsync(process.execPath, ["--check", file], { cwd: repoRoot });
}
console.log(`PASS | syntax lint | ${files.length} JavaScript files`);
