import { migrationV0ToV1 } from "./v0-to-v1.js";
import { migrationV1ToV2 } from "./v1-to-v2.js";
export const CONFIG_MIGRATIONS = Object.freeze([migrationV0ToV1, migrationV1ToV2]);
export function migrationFrom(version) { return CONFIG_MIGRATIONS.find((entry) => entry.from === version) ?? null; }
for (const migration of CONFIG_MIGRATIONS) if (migration.to !== migration.from + 1) throw new Error(`Invalid migration step: ${migration.id}`);
