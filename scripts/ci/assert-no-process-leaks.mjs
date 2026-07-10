import { execFileSync } from "node:child_process";

const patterns = [
  /scripts[\\/]serve\.py/,
  /e2e[\\/]test\.mjs/,
  /dist[\\/]electron[\\/]main\.cjs/,
  /dociai-(?:test|electron-smoke)-/,
];

function processListing() {
  if (process.platform === "win32") return execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8" });
  return execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
}

const currentPid = String(process.pid);
const leaks = processListing().split("\n").filter((line) => !line.includes(currentPid) && patterns.some((pattern) => pattern.test(line)));
if (leaks.length) {
  console.error("FAIL | process leaks detected");
  console.error(leaks.join("\n"));
  process.exitCode = 1;
} else {
  console.log("PASS | no managed dociai process leaks");
}
