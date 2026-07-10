import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeFailureArtifact } from "../test/artifact.mjs";

const outputDirectory = path.resolve(process.env.TEST_ARTIFACTS_DIR ?? path.join(process.cwd(), "test-results", "ci"));
const command = (name, args) => { try { return execFileSync(name, args, { encoding: "utf8" }).trim(); } catch (error) { return `${name} failed: ${error.message}`; } };
const summary = [
  "# dociai CI diagnostics",
  "",
  `- runner: ${process.env.GITHUB_ACTIONS === "true" ? "GitHub Actions" : "local"}`,
  `- node: ${process.version}`,
  `- npm: ${command("npm", ["--version"])}`,
  `- commit: ${command("git", ["rev-parse", "HEAD"])}`,
  `- ref: ${process.env.GITHUB_REF_NAME ?? command("git", ["branch", "--show-current"])}`,
  `- artifact directory: ${outputDirectory}`,
].join("\n");
await writeFailureArtifact(outputDirectory, "ci-summary.md", summary);
console.log(`INFO | diagnostics summary saved: ${outputDirectory}`);
