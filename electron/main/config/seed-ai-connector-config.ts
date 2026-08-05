import fs from "node:fs/promises";
import path from "node:path";
import type { AppPaths } from "../paths";
import type { SecretStore } from "../../shared/secret-contract";
import type { ConfigRepository } from "./config-repository";
import { parseSecretKey } from "../secrets/secret-keys";
import { backfillReferencedTriggers } from "./seed-merge";
// @ts-expect-error JavaScript config core intentionally has no separate declaration build.
import { splitConnectorSecrets } from "../../../src/config/config-secrets-split.js";

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }

async function readJsonRecord(file: string): Promise<JsonRecord | null> {
  try { return object(JSON.parse(await fs.readFile(file, "utf8"))); } catch { return null; }
}

async function exists(file: string): Promise<boolean> { return fs.access(file).then(() => true).catch(() => false); }

async function writePublicConfig(file: string, config: JsonRecord): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function seedAiConnectorConfig(configRepository: ConfigRepository, secretStore: SecretStore, paths: AppPaths, appPath: string): Promise<string> {
  const source = await exists(paths.configFile) ? paths.configFile : path.join(appPath, "config.local.example.json");
  const raw = await readJsonRecord(source);
  if (!raw) return source;
  const migrated = splitConnectorSecrets(raw);
  const current = await configRepository.getPublic();
  // #405 fix: Rendererの設定読込がconfig.local.json(legacy)からconfigRepository(config.json)
  // 経由に変わったため、personasが空のままだと最初の起動でvalidateConfig()が
  // 「personasが空です」で落ちて操作卓が起動しなくなる。personasは空配列だと保存自体が
  // validateConfigのエラーで常にブロックされる (src/config-loader.js) ため、「空」は
  // fresh install/破損以外ではあり得ず、毎回チェックしてbackfillしても安全。
  // 一方triggersは空オブジェクト {} が正当な保存済み状態になり得る (validateConfigは
  // 空triggersを許容する) ため、「空だからbackfillする」をtriggersに適用すると、ユーザーが
  // 設定UIで全トリガーを削除して保存するたびに毎起動でlegacy configのtriggersが復活して
  // しまう。triggersの引き継ぎはfresh installのときだけに限定する (connectorsと同じ扱い)。
  const isFreshInstall = !await exists(paths.configRepositoryFile);
  const missingNews = !("news" in current.config);
  const missingTopics = !("topics" in current.config);
  const missingPersonas = !Array.isArray(current.config.personas) || !current.config.personas.length;
  // Mainへ移管済みの資格情報だけをsafeStorageへ移し、次のサービス移管までは他の値を触らない。
  // legacy configの壊れた/文字種の合わないキー (parseSecretKey/assertNoSecretsが弾く値) で
  // アプリ全体の起動 (app.whenReady) を落とさないよう、1件ずつ握りつぶして続行する。
  // #254 fix: 対応するpublic configセクションが実際にbackfillされる回 (isFreshInstall/
  // missingNews/missingTopics、下のconfig backfillと同じ条件) だけ書き込む。以前はここが
  // 無条件で毎起動実行されており、topics.sources[]がconnectorsと違って配列indexキー
  // (topics.sources.0.token) なので、legacy config.local.json (またはfresh installで未作成の
  // 場合に読むbundle同梱のconfig.local.example.json — token: "your_todoist_personal_api_token"
  // というplaceholder入り) の同じindexにある値で、設定UIから設定し直した本物のTodoistトークンを
  // 毎起動で静かに上書きしていた。connectorsはユーザーが選んだid基準のkeyなのでこの上書きは
  // 実質衝突せず気づかれにくかった。
  // splitConnectorSecrets()は現状connectors/topics/newsの3種類のキーしか作らないため、
  // sectionNeedsSeed[section]がundefinedになることはない。将来ここにtopics.sourcesと同じ配列
  // indexキー方式の新sectionが追加された場合、undefined (!== false) は「意図的にunconditional
  // seed」ではなく単なるフォールスルーなので、この#254クラスの上書きバグが再発しないよう
  // sectionNeedsSeedの追加を忘れないこと。
  const sectionNeedsSeed: Record<string, boolean> = { connectors: isFreshInstall, topics: isFreshInstall || missingTopics, news: isFreshInstall || missingNews };
  for (const entry of migrated.secretEntries) {
    if (sectionNeedsSeed[entry.key.split(".")[0]] === false) continue;
    try { await secretStore.set(parseSecretKey(entry.key), entry.value); }
    catch (error) { console.error(`[dociai:seed] skipping unsaveable secret ${entry.key}`, error); }
  }
  const personasBackfill = missingPersonas && migrated.publicConfig.personas !== undefined ? migrated.publicConfig.personas : undefined;
  // isFreshInstallでなければtriggers全体は上書きしない (#405: ユーザーが設定UIで全トリガーを
  // 意図的に削除した状態を保つため) が、personaが「存在しないtrigger IDへの参照」を持つと
  // 起動のたびに設定警告になる。今回backfillするpersonasだけでなく、保存済みのpersonasも
  // 対象にするのは、trigger補完なしでpersonasだけをbackfillしていた旧バージョンが
  // 「personas[doci].triggers の mention_ai が triggers に存在しません」型の不整合を
  // config.jsonへ焼き込んでいるため — 参照されているIDに限定してlegacy configから補完する。
  // 設定UIはトリガー削除時にpersona側の参照も一緒に消すので、ユーザーが意図して削除した
  // トリガーがここで復活することはない (宙に浮いた参照はバグ残滓の場合だけ)。
  const triggersBackfill = isFreshInstall && migrated.publicConfig.triggers !== undefined
    ? migrated.publicConfig.triggers
    : backfillReferencedTriggers(current.config.triggers, personasBackfill ?? current.config.personas, migrated.publicConfig.triggers);
  if (isFreshInstall || missingNews || missingTopics || missingPersonas || triggersBackfill !== null) {
    const config = {
      ...current.config,
      schemaVersion: raw.schemaVersion ?? 1,
      // 各セクションはそれが実際に欠けている場合 (またはfresh install) にのみlegacy configから
      // 引き継ぐ。以前はガード全体がpersonas/triggers起因で発火するたび、connectors/news/topics
      // まで無条件に上書きしていたため、UIで空にしただけのtriggersを保存するたびにElectron設定UI
      // 経由で編集済みのconnectors (と実際のsafeStorage secretRef) が毎起動でlegacy configへ
      // 巻き戻っていた。
      ...(isFreshInstall ? { connectors: migrated.publicConfig.connectors ?? {} } : {}),
      ...((isFreshInstall || missingNews) && migrated.publicConfig.news !== undefined ? { news: migrated.publicConfig.news } : {}),
      ...((isFreshInstall || missingTopics) && migrated.publicConfig.topics !== undefined ? { topics: migrated.publicConfig.topics } : {}),
      ...(personasBackfill !== undefined ? { personas: personasBackfill } : {}),
      ...(triggersBackfill !== null ? { triggers: triggersBackfill } : {}),
    };
    try { await configRepository.save(config, current.revision); }
    catch (error) { console.error("[dociai:seed] failed to persist seeded config, continuing with in-memory defaults", error); }
  }
  // splitConnectorSecrets()はsectionNeedsSeedに関係なく全sectionのplaintextを一律で剥がして
  // migrated.publicConfigを作るため、そのまま書き戻すと「今回secretStoreへ実際には保存しなかった
  // section (sectionNeedsSeedがfalse)」のplaintextが、legacy config.local.json上からも
  // secretStore上からも両方消えてしまう (どこにも値が残らない状態) — PR #274レビューで指摘された
  // 不具合。gateされて今回seedしなかったsectionはrawの元の内容 (plaintextのまま) を書き戻す。
  const seededEntries = migrated.secretEntries.filter((entry: { key: string }) => sectionNeedsSeed[entry.key.split(".")[0]] !== false);
  if (source === paths.configFile && seededEntries.length) {
    const rewritten: JsonRecord = { ...migrated.publicConfig };
    for (const section of ["connectors", "topics", "news"]) {
      if (sectionNeedsSeed[section] === false && raw[section] !== undefined) rewritten[section] = raw[section];
    }
    await writePublicConfig(source, rewritten);
  }
  return source;
}
