import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { discoverMessagingShards, runMessagingShards, type MessagingShardOptions } from "./run-messaging-shards.ts";

const ORIGINAL_LOG = process.env.PISSZIP_FAKE_TRAINER_LOG;
const ORIGINAL_FAIL = process.env.PISSZIP_FAKE_TRAINER_FAIL;

afterEach(() => {
  setEnvironment("PISSZIP_FAKE_TRAINER_LOG", ORIGINAL_LOG);
  setEnvironment("PISSZIP_FAKE_TRAINER_FAIL", ORIGINAL_FAIL);
});

describe("resumable messaging shard coordinator", () => {
  test("discovers supported archives, runs them concurrently, and skips completed shards", async () => {
    const fixture = createFixture(["TGDataset_1.tar.gz", "TGDataset_2.tar.gz", "TGDataset_3.tar.gz"]);
    process.env.PISSZIP_FAKE_TRAINER_LOG = fixture.log;

    const discovered = discoverMessagingShards(fixture.input);
    expect(discovered.map((entry) => entry.path.split(/[\\/]/).at(-1))).toEqual([
      "TGDataset_1.tar.gz",
      "TGDataset_2.tar.gz",
      "TGDataset_3.tar.gz",
    ]);

    const first = await runMessagingShards(fixture.options);
    const invocations = readInvocations(fixture.log);
    expect(first.state).toBe("complete");
    expect(first.completedCubePaths).toHaveLength(3);
    expect(invocations.filter((event) => event.event === "start")).toHaveLength(3);
    expect(maximumConcurrency(invocations)).toBeGreaterThan(1);

    const second = await runMessagingShards(fixture.options);
    expect(second.state).toBe("complete");
    expect(second.shards.every((shard) => shard.resumed)).toBe(true);
    expect(readInvocations(fixture.log)).toHaveLength(invocations.length);

    appendFileSync(join(fixture.input, "TGDataset_2.tar.gz"), "changed");
    const third = await runMessagingShards(fixture.options);
    expect(third.state).toBe("complete");
    expect(third.shards.filter((shard) => shard.resumed)).toHaveLength(2);
    expect(readInvocations(fixture.log).filter((event) => event.event === "start")).toHaveLength(4);
  });

  test("continues other shards after one process fails and records a partial manifest", async () => {
    const fixture = createFixture(["TGDataset_good.tar.gz", "TGDataset_fail.tar.gz"]);
    process.env.PISSZIP_FAKE_TRAINER_LOG = fixture.log;
    process.env.PISSZIP_FAKE_TRAINER_FAIL = "TGDataset_fail";

    const manifest = await runMessagingShards(fixture.options);

    expect(manifest.state).toBe("partial");
    expect(manifest.shards.find((shard) => shard.inputPath.includes("good"))?.status).toBe("complete");
    expect(manifest.shards.find((shard) => shard.inputPath.includes("fail"))?.status).toBe("failed");
    expect(manifest.completedCubePaths).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(fixture.output, "manifest.json"), "utf8")).state).toBe("partial");
  });
});

function createFixture(names: string[]): {
  input: string;
  output: string;
  log: string;
  options: MessagingShardOptions;
} {
  const root = mkdtempSync(join(tmpdir(), "pisszip-shards-"));
  const input = join(root, "corpora", "tgdataset");
  const output = join(root, "output");
  const log = join(root, "invocations.jsonl");
  const trainer = join(root, "fake-trainer.mjs");
  const suffixes = join(root, "public_suffix_list.dat");
  mkdirSync(input, { recursive: true });
  for (const name of names) writeFileSync(join(input, name), name);
  writeFileSync(suffixes, "com\norg\n");
  writeFileSync(trainer, fakeTrainerSource());
  return {
    input,
    output,
    log,
    options: {
      inputRoot: input,
      outputRoot: output,
      trainerCommand: process.execPath,
      trainerPrefixArgs: [trainer],
      publicSuffixList: suffixes,
      collection: "fixture",
      jobs: 3,
      threadsPerShard: 1,
      checkpointRows: 30,
      reportEverySecs: 60,
      heldoutUrls: 10,
      heldoutEvery: 1,
    },
  };
}

function fakeTrainerSource(): string {
  return `
import { appendFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const args = process.argv.slice(2);
const input = args[0];
const value = (name) => args[args.indexOf(name) + 1];
const log = process.env.PISSZIP_FAKE_TRAINER_LOG;
appendFileSync(log, JSON.stringify({ event: "start", input, at: Date.now() }) + "\\n");
await new Promise((resolve) => setTimeout(resolve, 150));
if (input.includes(process.env.PISSZIP_FAKE_TRAINER_FAIL || "__never__")) {
  appendFileSync(log, JSON.stringify({ event: "end", input, at: Date.now(), failed: true }) + "\\n");
  process.exit(7);
}
const metadata = JSON.stringify({ type: "metadata", schemaVersion: 1, collection: value("--collection"), datasets: [], datasetFamilies: [], contexts: [], defaultDatasetWeights: [], defaultContextWeights: [], signalIndex: "fixture" }) + "\\n";
writeFileSync(value("--raw-stats"), gzipSync(metadata));
writeFileSync(value("--header-heldout"), gzipSync("{}\\n"));
writeFileSync(value("--header-stats"), "{}\\n");
writeFileSync(value("--out"), "# fixture\\n");
appendFileSync(log, JSON.stringify({ event: "end", input, at: Date.now(), failed: false }) + "\\n");
`;
}

type Invocation = { event: "start" | "end"; input: string; at: number };

function readInvocations(path: string): Invocation[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function maximumConcurrency(events: Invocation[]): number {
  const ordered = [...events].sort((left, right) => left.at - right.at || (left.event === "start" ? -1 : 1));
  let active = 0;
  let maximum = 0;
  for (const event of ordered) {
    active += event.event === "start" ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
