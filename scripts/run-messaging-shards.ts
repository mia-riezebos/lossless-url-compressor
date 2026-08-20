import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { spawn } from "node:child_process";

export type MessagingShardOptions = {
  inputRoot: string;
  outputRoot: string;
  trainerCommand: string;
  trainerPrefixArgs?: string[];
  publicSuffixList: string;
  collection: string;
  jobs: number;
  threadsPerShard: number;
  checkpointRows: number;
  reportEverySecs: number;
  heldoutUrls: number;
  heldoutEvery: number;
};

export type ShardStatus = "pending" | "running" | "complete" | "failed";

export type MessagingShardRecord = {
  id: string;
  kind: MessagingShardKind;
  inputPath: string;
  inputBytes: number;
  fingerprint: string;
  status: ShardStatus;
  resumed: boolean;
  startedAt?: string;
  completedAt?: string;
  elapsedSeconds?: number;
  exitCode?: number;
  error?: string;
  cubePath: string;
  heldoutPath: string;
  headerStatsPath: string;
  reportPath: string;
  stdoutPath: string;
  stderrPath: string;
  completionPath: string;
};

export type MessagingShardManifest = {
  schemaVersion: 1;
  state: "running" | "complete" | "partial";
  generatedAt: string;
  inputRoot: string;
  outputRoot: string;
  jobs: number;
  threadsPerShard: number;
  shards: MessagingShardRecord[];
  completedCubePaths: string[];
};

type MessagingShardKind = "discord-unveiled" | "tgdataset" | "disco" | "telegram-groupverse" | "whatsapp";

const MANIFEST_NAME = "manifest.json";
const COMPLETION_SCHEMA = 1;

export async function runMessagingShards(options: MessagingShardOptions): Promise<MessagingShardManifest> {
  validateOptions(options);
  const normalized = normalizeOptions(options);
  mkdirSync(normalized.outputRoot, { recursive: true });
  const sharedFingerprint = fingerprint({
    schemaVersion: COMPLETION_SCHEMA,
    trainerSha256: hashFile(normalized.trainerCommand),
    trainerPrefixArgs: normalized.trainerPrefixArgs.map((argument) => (
      existsSync(argument) && statSync(argument).isFile()
        ? { argument, sha256: hashFile(argument) }
        : { argument }
    )),
    publicSuffixListSha256: hashFile(normalized.publicSuffixList),
    collection: normalized.collection,
    threadsPerShard: normalized.threadsPerShard,
    checkpointRows: normalized.checkpointRows,
    reportEverySecs: normalized.reportEverySecs,
    heldoutUrls: normalized.heldoutUrls,
    heldoutEvery: normalized.heldoutEvery,
  });
  const inputs = discoverMessagingShards(normalized.inputRoot);
  if (inputs.length === 0) throw new Error(`No supported messaging archives found under ${normalized.inputRoot}`);

  const records = inputs.map(({ path, kind }) => createRecord(normalized, path, kind, sharedFingerprint));
  for (const record of records) {
    if (isCompleted(record)) {
      record.status = "complete";
      record.resumed = true;
    }
  }

  const manifestPath = join(normalized.outputRoot, MANIFEST_NAME);
  let manifest = buildManifest(normalized, records, "running");
  writeManifest(manifestPath, manifest);

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= records.length) return;
      const record = records[index];
      if (record.status === "complete") continue;

      record.status = "running";
      record.startedAt = new Date().toISOString();
      manifest = buildManifest(normalized, records, "running");
      writeManifest(manifestPath, manifest);
      await runShard(normalized, record);
      manifest = buildManifest(normalized, records, "running");
      writeManifest(manifestPath, manifest);
    }
  }

  await Promise.all(Array.from({ length: Math.min(normalized.jobs, records.length) }, () => worker()));
  const state = records.some((record) => record.status === "failed") ? "partial" : "complete";
  manifest = buildManifest(normalized, records, state);
  writeManifest(manifestPath, manifest);
  return manifest;
}

export function discoverMessagingShards(inputRoot: string): Array<{ path: string; kind: MessagingShardKind }> {
  const root = resolve(inputRoot);
  const paths: string[] = [];
  collectFiles(root, paths);
  return paths
    .sort((left, right) => left.localeCompare(right))
    .flatMap((path) => {
      const kind = classifyMessagingInput(path);
      return kind ? [{ path, kind }] : [];
    });
}

function classifyMessagingInput(path: string): MessagingShardKind | undefined {
  const filename = basename(path);
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (filename === "dataset.zst" && normalized.includes("discord-unveiled")) return "discord-unveiled";
  if (filename.startsWith("TGDataset_") && filename.endsWith(".tar.gz")) return "tgdataset";
  if (filename.startsWith("DISCO-") && filename.endsWith(".zip")) return "disco";
  if (filename === "sample.zip" && normalized.includes("telegram-groupverse")) return "telegram-groupverse";
  if (filename === "anonymised_data_to_share.tsv") return "whatsapp";
  return undefined;
}

function collectFiles(path: string, files: string[]): void {
  const stat = statSync(path);
  if (stat.isFile()) {
    files.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) collectFiles(child, files);
    else if (entry.isFile()) files.push(child);
  }
}

function createRecord(
  options: MessagingShardOptions,
  inputPath: string,
  kind: MessagingShardKind,
  sharedFingerprint: string,
): MessagingShardRecord {
  const stat = statSync(inputPath);
  const relativePath = relative(options.inputRoot, inputPath).replaceAll("\\", "/");
  const pathHash = fingerprint(relativePath).slice(0, 10);
  const plainName = basename(inputPath).replace(/(?:\.tar\.gz|\.[^.]+)$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const id = `${kind}-${plainName}-${pathHash}`;
  const shardRoot = join(options.outputRoot, "shards", id);
  mkdirSync(shardRoot, { recursive: true });
  return {
    id,
    kind,
    inputPath,
    inputBytes: stat.size,
    fingerprint: fingerprint({
      sharedFingerprint,
      relativePath,
      inputBytes: stat.size,
      inputModifiedMs: stat.mtimeMs,
    }),
    status: "pending",
    resumed: false,
    cubePath: join(shardRoot, "cube.jsonl.gz"),
    heldoutPath: join(shardRoot, "heldout.jsonl.gz"),
    headerStatsPath: join(shardRoot, "header-stats.json"),
    reportPath: join(shardRoot, "report.md"),
    stdoutPath: join(shardRoot, "stdout.log"),
    stderrPath: join(shardRoot, "stderr.log"),
    completionPath: join(shardRoot, "complete.json"),
  };
}

function isCompleted(record: MessagingShardRecord): boolean {
  if (!existsSync(record.completionPath)) return false;
  try {
    const completion = JSON.parse(readFileSync(record.completionPath, "utf8")) as {
      schemaVersion?: number;
      fingerprint?: string;
    };
    return completion.schemaVersion === COMPLETION_SCHEMA
      && completion.fingerprint === record.fingerprint
      && requiredArtifacts(record).every((path) => existsSync(path) && statSync(path).size > 0);
  } catch {
    return false;
  }
}

async function runShard(options: MessagingShardOptions, record: MessagingShardRecord): Promise<void> {
  rmSync(record.completionPath, { force: true });
  const started = performance.now();
  const stdout = createWriteStream(record.stdoutPath, { flags: "w" });
  const stderr = createWriteStream(record.stderrPath, { flags: "w" });
  const args = [
    ...options.trainerPrefixArgs!,
    record.inputPath,
    "--format", "messaging-archives",
    "--collection", `${options.collection}/${record.id}`,
    "--public-suffix-list", options.publicSuffixList,
    "--out", record.reportPath,
    "--raw-stats", record.cubePath,
    "--header-stats", record.headerStatsPath,
    "--header-heldout", record.heldoutPath,
    "--threads", String(options.threadsPerShard),
    "--checkpoint-rows", String(options.checkpointRows),
    "--report-every-secs", String(options.reportEverySecs),
    "--heldout-urls", String(options.heldoutUrls),
    "--heldout-every", String(options.heldoutEvery),
  ];

  try {
    const child = spawn(options.trainerCommand, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    const [code] = await once(child, "close") as [number | null];
    await Promise.all([finished(stdout), finished(stderr)]);
    record.exitCode = code ?? -1;
    record.elapsedSeconds = Math.round((performance.now() - started) / 100) / 10;
    record.completedAt = new Date().toISOString();
    if (code !== 0) {
      record.status = "failed";
      record.error = `Trainer exited with code ${code ?? "unknown"}`;
      return;
    }
    const missing = requiredArtifacts(record).filter((path) => !existsSync(path) || statSync(path).size === 0);
    if (missing.length > 0) {
      record.status = "failed";
      record.error = `Trainer omitted required artifacts: ${missing.join(", ")}`;
      return;
    }
    const completion = {
      schemaVersion: COMPLETION_SCHEMA,
      fingerprint: record.fingerprint,
      inputPath: record.inputPath,
      inputBytes: record.inputBytes,
      completedAt: record.completedAt,
      elapsedSeconds: record.elapsedSeconds,
      artifacts: {
        cube: record.cubePath,
        heldout: record.heldoutPath,
        headerStats: record.headerStatsPath,
        report: record.reportPath,
      },
    };
    writeJsonAtomic(record.completionPath, completion);
    record.status = "complete";
  } catch (error) {
    stdout.end();
    stderr.end();
    record.status = "failed";
    record.exitCode = -1;
    record.elapsedSeconds = Math.round((performance.now() - started) / 100) / 10;
    record.completedAt = new Date().toISOString();
    record.error = error instanceof Error ? error.message : String(error);
  }
}

function requiredArtifacts(record: MessagingShardRecord): string[] {
  return [record.cubePath, record.heldoutPath, record.headerStatsPath, record.reportPath];
}

function buildManifest(
  options: MessagingShardOptions,
  shards: MessagingShardRecord[],
  requestedState: MessagingShardManifest["state"],
): MessagingShardManifest {
  const completedCubePaths = shards
    .filter((record) => record.status === "complete")
    .map((record) => record.cubePath);
  return {
    schemaVersion: 1,
    state: requestedState === "running" && shards.every((record) => record.status === "complete")
      ? "complete"
      : requestedState,
    generatedAt: new Date().toISOString(),
    inputRoot: options.inputRoot,
    outputRoot: options.outputRoot,
    jobs: options.jobs,
    threadsPerShard: options.threadsPerShard,
    shards,
    completedCubePaths,
  };
}

function writeManifest(path: string, manifest: MessagingShardManifest): void {
  writeJsonAtomic(path, manifest);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function normalizeOptions(options: MessagingShardOptions): MessagingShardOptions {
  return {
    ...options,
    inputRoot: resolve(options.inputRoot),
    outputRoot: resolve(options.outputRoot),
    trainerCommand: resolve(options.trainerCommand),
    trainerPrefixArgs: options.trainerPrefixArgs ?? [],
    publicSuffixList: resolve(options.publicSuffixList),
  };
}

function validateOptions(options: MessagingShardOptions): void {
  for (const [name, value] of [["jobs", options.jobs], ["threadsPerShard", options.threadsPerShard]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (!existsSync(options.inputRoot)) throw new Error(`Messaging input is unavailable: ${options.inputRoot}`);
  if (!existsSync(options.trainerCommand)) throw new Error(`Trainer command is unavailable: ${options.trainerCommand}`);
  if (!existsSync(options.publicSuffixList)) throw new Error(`Public suffix list is unavailable: ${options.publicSuffixList}`);
}

function parseArgs(args: string[]): MessagingShardOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Expected --name value, got ${key ?? "end of input"}`);
    values.set(key, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    inputRoot: required("--input"),
    outputRoot: required("--output"),
    trainerCommand: required("--trainer"),
    publicSuffixList: required("--public-suffix-list"),
    collection: values.get("--collection") ?? "public-messaging-links",
    jobs: Number(values.get("--jobs") ?? 2),
    threadsPerShard: Number(values.get("--threads-per-shard") ?? 2),
    checkpointRows: Number(values.get("--checkpoint-rows") ?? 30_000),
    reportEverySecs: Number(values.get("--report-every-secs") ?? 60),
    heldoutUrls: Number(values.get("--heldout-urls") ?? 20_000),
    heldoutEvery: Number(values.get("--heldout-every") ?? 10),
  };
}

function isMain(): boolean {
  return process.argv[1] && basename(process.argv[1]).replace(/\.[^.]+$/, "") === basename(import.meta.url).replace(/\.[^.]+$/, "");
}

if (isMain()) {
  runMessagingShards(parseArgs(process.argv.slice(2)))
    .then((manifest) => {
      process.stdout.write(`${JSON.stringify({
        state: manifest.state,
        completed: manifest.shards.filter((shard) => shard.status === "complete").length,
        failed: manifest.shards.filter((shard) => shard.status === "failed").length,
        manifest: join(manifest.outputRoot, MANIFEST_NAME),
      })}\n`);
      if (manifest.state === "partial") process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
