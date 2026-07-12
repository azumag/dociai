import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { redactLogFile } from "../release/redact-log.mjs";

test("redactLogFile replaces every named env var's value in the file, and reports how many secrets were actually present", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-redact-log-"));
  try {
    const file = path.join(tmpRoot, "publish.log");
    await fs.writeFile(file, "gh release create v1.0.0 --token hunter2-token-value\nrequest failed with token hunter2-token-value again\n");

    const result = await redactLogFile(file, ["GH_TOKEN", "UNSET_VAR"], { GH_TOKEN: "hunter2-token-value" });
    assert.equal(result.redactedCount, 1, "UNSET_VAR is absent from env and must not count or corrupt the file");

    const redacted = await fs.readFile(file, "utf8");
    assert.equal(redacted.includes("hunter2-token-value"), false);
    assert.match(redacted, /gh release create v1\.0\.0 --token \*\*\*/);
    assert.match(redacted, /request failed with token \*\*\* again/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("redactLogFile is a no-op (besides re-writing the same content) when none of the named env vars are set", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-redact-log-noop-"));
  try {
    const file = path.join(tmpRoot, "publish.log");
    const original = "nothing secret here\n";
    await fs.writeFile(file, original);
    const result = await redactLogFile(file, ["NOT_SET"], {});
    assert.equal(result.redactedCount, 0);
    assert.equal(await fs.readFile(file, "utf8"), original);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
