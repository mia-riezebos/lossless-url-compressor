import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { heldoutBucket } from "./heldout-sampling";

export type RouteAlphabet = "base64url" | "decimal" | "hex" | "lower-hyphen";

export type TrainedRoute = {
  value: string;
  weightedCount: number;
  suffix?: { alphabet: RouteAlphabet; length: number; confidence: number; observations: number };
};

type HeldoutRecord = {
  url: string;
  registrableDomain: string;
  dataset: string;
  linkClass: string;
  linkPresentation: string;
};

type TermCandidate = { key: string; weightedCount: number; estimatedBitsSaved: number };
type PatternCandidate = {
  host: string;
  patternKind: string;
  term: string;
  weightedCount: number;
  estimatedTailBitsSaved: number;
};

const root = resolve(import.meta.dirname, "..");
const reports = resolve(root, process.argv[2] ?? "data/training/full-2026-08-18/reports");
const trainingRoot = resolve(reports, "..");
const output = resolve(root, process.argv[3] ?? join(reports, "tokenizer-model.json"));
const payloadBudget = 44;
const hostBudget = 64;
const routesPerHost = 8;

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  await train();
}

async function train(): Promise<void> {
  const symbols = JSON.parse(await readFile(join(reports, "common-symbols.json"), "utf8")) as {
    dictionaryTerms: TermCandidate[];
  };
  const patterns = JSON.parse(await readFile(join(reports, "host-patterns.json"), "utf8")) as {
    patterns: PatternCandidate[];
  };
  const headers = JSON.parse(await readFile(join(reports, "header-shortlists.json"), "utf8")) as {
    modes: Array<{ best: { tier1: HeaderChoice[]; tier2: HeaderChoice[]; tier3: HeaderChoice[] } }>;
  };

  const payloadTerms = selectUniversalTerms(symbols.dictionaryTerms, payloadBudget);
  const selectedHosts = new Set(headers.modes.flatMap((mode) => [
    ...mode.best.tier1,
    ...mode.best.tier2,
    ...mode.best.tier3,
  ]).filter((entry) => entry.kind === "host").map((entry) => entry.key));
  const routeCandidates = selectRouteCandidates(patterns.patterns, selectedHosts, hostBudget, routesPerHost);
  const heldoutFiles = await discoverHeldoutFiles(trainingRoot);
  const tails = await collectRelevantTails(heldoutFiles, new Set(routeCandidates.keys()));
  const hostRoutes = Object.fromEntries([...routeCandidates].map(([host, candidates]) => [
    host,
    candidates.map((candidate) => ({
      value: candidate.term,
      weightedCount: candidate.weightedCount,
      suffix: inferStructuredSuffix(tails.get(host) ?? [], candidate.term),
    } satisfies TrainedRoute)),
  ]));

  const model = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    reports: reports.replaceAll("\\", "/"),
    heldoutFiles: heldoutFiles.map((file) => file.replaceAll("\\", "/")),
    objective: "Weighted residual savings after header removal. Carrier alphabets are fixed and are not an optimization input.",
    budgets: { universalTerms: payloadBudget, hosts: hostBudget, routesPerHost },
    payloadTerms,
    hostRoutes,
  };
  await writeFile(output, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`wrote ${output}`);
  console.log(`universal terms ${payloadTerms.length}`);
  console.log(`host route tables ${Object.keys(hostRoutes).length}`);
  console.log(`structured routes ${Object.values(hostRoutes).flat().filter((route) => route.suffix).length}`);
}

type HeaderChoice = { key: string; kind: "host" | "suffix" };

export function selectUniversalTerms(candidates: TermCandidate[], limit: number): string[] {
  const selected: TermCandidate[] = [];
  for (const candidate of [...candidates].sort((left, right) =>
    right.estimatedBitsSaved - left.estimatedBitsSaved || right.key.length - left.key.length
  )) {
    if (!validTerm(candidate.key)) continue;
    const redundant = selected.some((existing) => {
      if (existing.key.includes(candidate.key)) {
        return candidate.weightedCount <= existing.weightedCount * 1.1;
      }
      if (candidate.key.includes(existing.key)) {
        return candidate.weightedCount <= existing.weightedCount * 0.8;
      }
      return false;
    });
    if (redundant) continue;
    selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected.map((entry) => entry.key);
}

function selectRouteCandidates(
  candidates: PatternCandidate[],
  selectedHosts: Set<string>,
  hostLimit: number,
  perHostLimit: number,
): Map<string, PatternCandidate[]> {
  const eligibleKinds = new Set(["prefix-query", "path-prefix", "path-segment", "query-first", "query-later"]);
  const grouped = new Map<string, PatternCandidate[]>();
  for (const candidate of candidates) {
    if (!selectedHosts.has(candidate.host) || !eligibleKinds.has(candidate.patternKind) || !validRouteTerm(candidate.term)) continue;
    const entries = grouped.get(candidate.host) ?? [];
    if (!entries.some((entry) => entry.term === candidate.term)) entries.push(candidate);
    grouped.set(candidate.host, entries);
  }
  return new Map([...grouped]
    .map(([host, entries]) => [host, entries
      .sort((left, right) => right.estimatedTailBitsSaved - left.estimatedTailBitsSaved)
      .slice(0, perHostLimit)] as const)
    .sort((left, right) => sumRouteScore(right[1]) - sumRouteScore(left[1]))
    .slice(0, hostLimit));
}

function sumRouteScore(entries: PatternCandidate[]): number {
  return entries.reduce((sum, entry) => sum + entry.estimatedTailBitsSaved, 0);
}

function validTerm(value: string): boolean {
  return value.length >= 3 && value.length <= 64 && !/[\u0000-\u0020\u007f]/.test(value);
}

export function validRouteTerm(value: string): boolean {
  if (!validTerm(value) || !/^[/?&]/.test(value)) return false;
  if (/[\[\]\\*]/.test(value) || /https?:/i.test(value)) return false;
  if (/%(?![0-9a-f]{2})/i.test(value)) return false;
  return true;
}

async function discoverHeldoutFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith("heldout.jsonl.gz")) found.push(path);
    }
  }
  await visit(directory);

  const manualThree = found.find((file) => file.includes("manual-sequential-retry") && file.includes("tgdataset-3"));
  const manualFour = found.find((file) => file.includes("manual-sequential-retry") && file.includes("tgdataset-4"));
  return found.filter((file) => {
    if (manualThree && file.includes("messaging-shards") && file.includes("TGDataset_3")) return false;
    if (manualFour && file.includes("messaging-shards") && file.includes("TGDataset_4")) return false;
    return true;
  }).sort();
}

async function collectRelevantTails(files: string[], hosts: Set<string>): Promise<Map<string, string[]>> {
  const tails = new Map<string, string[]>();
  for (const file of files) {
    if ((await stat(file)).size === 0) continue;
    const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line) as HeldoutRecord;
      if (heldoutBucket(record) >= 70) continue;
      if (!hosts.has(record.registrableDomain)) continue;
      try {
        const parsed = new URL(record.url);
        const tail = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        const entries = tails.get(record.registrableDomain) ?? [];
        entries.push(tail);
        tails.set(record.registrableDomain, entries);
      } catch {
        // The ingestion layer records failures; tokenizer training simply ignores malformed held-out rows.
      }
    }
  }
  return tails;
}

export function inferStructuredSuffix(
  tails: string[],
  prefix: string,
): TrainedRoute["suffix"] | undefined {
  const observations = new Map<string, number>();
  let total = 0;
  for (const tail of tails) {
    let offset = tail.indexOf(prefix);
    while (offset !== -1) {
      const remainder = tail.slice(offset + prefix.length);
      const classified = classifyRun(remainder);
      if (classified && classified.length >= 4 && classified.length <= 32) {
        const key = `${classified.alphabet}:${classified.length}`;
        observations.set(key, (observations.get(key) ?? 0) + 1);
        total += 1;
      }
      offset = tail.indexOf(prefix, offset + prefix.length);
    }
  }
  if (total < 5) return undefined;
  const [best, count] = [...observations].sort((left, right) => right[1] - left[1])[0] ?? [];
  if (!best || !count || count / total < 0.8) return undefined;
  const [alphabet, rawLength] = best.split(":") as [RouteAlphabet, string];
  return { alphabet, length: Number(rawLength), confidence: count / total, observations: total };
}

function classifyRun(value: string): { alphabet: RouteAlphabet; length: number } | undefined {
  const run = /^[A-Za-z0-9_-]+/.exec(value)?.[0];
  if (!run) return undefined;
  if (/^\d+$/.test(run)) return { alphabet: "decimal", length: run.length };
  if (/^[0-9a-fA-F]+$/.test(run) && /[a-fA-F]/.test(run)) return { alphabet: "hex", length: run.length };
  if (/^[a-z-]+$/.test(run) && run.includes("-")) return { alphabet: "lower-hyphen", length: run.length };
  return { alphabet: "base64url", length: run.length };
}
