import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { ASCII_SERVER_ALPHABET } from "../src/alphabet.ts";
import { encodeTokenStreamV1 } from "../src/coder-v1.ts";
import { encodeTerminatedBits } from "../src/radix.ts";
import { tokenize } from "../src/tokenize.ts";

type CorpusRecord = {
  url: string;
  hostname: string;
  suffix: string;
  registrableDomain: string;
  hasWww: boolean;
  linkClass?: string;
  linkPresentation?: string;
  sourceUrl?: string;
  sourceHostname?: string;
  sourceRegistrableDomain?: string;
  displayText?: string;
  linkHref?: string;
};

type CorpusStats = {
  collection: string;
  rowsSampled: number;
  supportedUrls: number;
  topSuffixes: Array<[string, number]>;
  topHosts: Array<[string, number]>;
  topSources?: Array<[string, number]>;
  classes?: string[];
  defaultWeights?: number[];
  classTotals?: number[];
  suffixClassCounts?: Array<[string, number[]]>;
  hostClassCounts?: Array<[string, number[]]>;
  sourceClassCounts?: Array<[string, number[]]>;
  termClassCounts?: Array<[string, number[]]>;
};

type Gain = {
  key: string;
  suffix: string;
  evaluated: number[];
  classCounts: number[];
  corpusCount: number;
  gain2WithoutSuffix: number[];
  gain3WithoutSuffix: number[];
  gain2WithSuffix: number[];
  gain3WithSuffix: number[];
  foundOn: Map<string, number>;
};

type SuffixGain = {
  key: string;
  evaluated: number[];
  classCounts: number[];
  corpusCount: number;
  gain2ByClass: number[];
  gain2: number;
  unadjustedGain2: number;
  ccTldMultiplier: number;
  foundOn: Map<string, number>;
};

type HostChoice = Gain & { gain2: number; gain3: number };

const STRUCTURAL_STATES = 16;
const BASE = 81;
const COMPACT_LEADS = 64;
const GENERIC_LEADS = 1;
const EXTENDED_LEADS = BASE - COMPACT_LEADS - GENERIC_LEADS;
const COMPACT_SUFFIXES = new Set(["com", "net", "org"]);
const DEFAULT_EXCLUDED_HOSTS = new Set([
  "amzn.to",
  "bit.ly",
  "bl.ink",
  "buff.ly",
  "clck.ru",
  "cutt.ly",
  "dlvr.it",
  "fb.me",
  "goo.gl",
  "ift.tt",
  "is.gd",
  "j.mp",
  "lnkd.in",
  "ow.ly",
  "rb.gy",
  "rebrand.ly",
  "s.id",
  "short.io",
  "shorturl.at",
  "soo.gd",
  "t.co",
  "t.ly",
  "t.me",
  "tiny.cc",
  "tiny.one",
  "tinyurl.com",
  "trib.al",
  "urlz.fr",
  "v.gd",
  "wa.me",
  "youtu.be",
]);

const options = parseArgs(process.argv.slice(2));
if (!Number.isFinite(options.ccTldWeight) || options.ccTldWeight < 0 || options.ccTldWeight > 1) {
  throw new Error("--cc-tld-weight must be between 0 and 1");
}
const stats = JSON.parse(readFileSync(options.stats, "utf8")) as CorpusStats;
const classNames = stats.classes ?? ["unweighted"];
const classIndexes = new Map(classNames.map((name, index) => [name, index]));
const weights = parseWeights(options.weights, classNames, stats.defaultWeights);
const sourceWeights = parseSourceWeights(options.sourceWeights);
const excludedHosts = new Set([
  ...DEFAULT_EXCLUDED_HOSTS,
  ...parseHostList(options.excludeHosts),
]);
const hostClassCounts = classCountMap(stats.hostClassCounts, stats.topHosts, classNames.length);
const suffixClassCounts = classCountMap(stats.suffixClassCounts, stats.topSuffixes, classNames.length);
const sourceClassCounts = classCountMap(stats.sourceClassCounts, stats.topSources ?? [], classNames.length);
const hostCorpusCounts = weightedCorpusCounts(hostClassCounts, weights);
const suffixCorpusCounts = weightedCorpusCounts(suffixClassCounts, weights);
const sourceCorpusScores = weightedCorpusCounts(sourceClassCounts, weights);
const hostCandidates = new Set(
  [...hostCorpusCounts.entries()]
    .filter(([host]) => !excludedHosts.has(host.toLowerCase()))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, options.hostCandidates)
    .map(([host]) => host),
);
const suffixCandidates = new Set(
  [...suffixCorpusCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, options.suffixCandidates)
    .map(([suffix]) => suffix)
    .filter((suffix) => !COMPACT_SUFFIXES.has(suffix)),
);

const hostGains = new Map<string, Gain>();
const suffixGains = new Map<string, SuffixGain>();
const compactSuffixGains = new Map<string, SuffixGain>();
let evaluatedUrls = 0;
let baselineCharacters = 0;

for await (const record of readRecords(options.heldout, options.limitUrls)) {
  const parts = residualParts(record);
  if (!parts) continue;
  evaluatedUrls += 1;
  const classIndex = classIndexes.get(recordWeightClass(record, classIndexes)) ?? 0;
  const sourceWeight = sourceWeights.get(record.sourceRegistrableDomain?.toLowerCase() ?? "") ?? 1;

  const rawLength = payloadLength(`${parts.authorityPrefix}${record.hostname}${parts.authoritySuffix}${parts.tail}`);
  const compactSuffixBody = stripSuffix(record.hostname, record.suffix);
  const compactPayload = COMPACT_SUFFIXES.has(record.suffix)
    ? payloadLength(`${parts.authorityPrefix}${compactSuffixBody}${parts.authoritySuffix}${parts.tail}`)
    : rawLength;
  const baseline = 1 + compactPayload;
  const genericBaseline = 1 + rawLength;
  baselineCharacters += baseline * weights[classIndex] * sourceWeight;

  if (COMPACT_SUFFIXES.has(record.suffix)) {
    const gain = compactSuffixGains.get(record.suffix) ?? newSuffixGain(
      record.suffix,
      suffixClassCounts,
      suffixCorpusCounts,
      classNames.length,
      1,
    );
    gain.evaluated[classIndex] += 1;
    gain.gain2ByClass[classIndex] += Math.max(0, genericBaseline - baseline) * sourceWeight;
    bumpFoundOn(gain.foundOn, record.sourceRegistrableDomain, weights[classIndex] * sourceWeight);
    compactSuffixGains.set(record.suffix, gain);
  }

  let suffixTotal = Number.POSITIVE_INFINITY;
  if (suffixCandidates.has(record.suffix)) {
    suffixTotal = 2 + payloadLength(
      `${parts.authorityPrefix}${stripSuffix(record.hostname, record.suffix)}${parts.authoritySuffix}${parts.tail}`,
    );
    const gain = suffixGains.get(record.suffix) ?? newSuffixGain(
      record.suffix,
      suffixClassCounts,
      suffixCorpusCounts,
      classNames.length,
      isCountryCodeSuffix(record.suffix) ? options.ccTldWeight : 1,
    );
    gain.evaluated[classIndex] += 1;
    gain.gain2ByClass[classIndex] += Math.max(0, baseline - suffixTotal) * sourceWeight;
    bumpFoundOn(gain.foundOn, record.sourceRegistrableDomain, weights[classIndex] * sourceWeight);
    suffixGains.set(record.suffix, gain);
  }

  if (hostCandidates.has(record.registrableDomain)) {
    const hostBody = stripHost(record.hostname, record.registrableDomain);
    const hostPayload = payloadLength(`${parts.authorityPrefix}${hostBody}${parts.authoritySuffix}${parts.tail}`);
    const host2 = 2 + hostPayload;
    const host3 = 3 + hostPayload;
    const withSuffixBaseline = Math.min(baseline, suffixTotal);
    const gain = hostGains.get(record.registrableDomain) ?? {
      key: record.registrableDomain,
      suffix: record.suffix,
      evaluated: zeros(classNames.length),
      classCounts: hostClassCounts.get(record.registrableDomain) ?? zeros(classNames.length),
      corpusCount: hostCorpusCounts.get(record.registrableDomain) ?? 0,
      gain2WithoutSuffix: zeros(classNames.length),
      gain3WithoutSuffix: zeros(classNames.length),
      gain2WithSuffix: zeros(classNames.length),
      gain3WithSuffix: zeros(classNames.length),
      foundOn: new Map(),
    };
    gain.evaluated[classIndex] += 1;
    gain.gain2WithoutSuffix[classIndex] += Math.max(0, baseline - host2) * sourceWeight;
    gain.gain3WithoutSuffix[classIndex] += Math.max(0, baseline - host3) * sourceWeight;
    gain.gain2WithSuffix[classIndex] += Math.max(0, withSuffixBaseline - host2) * sourceWeight;
    gain.gain3WithSuffix[classIndex] += Math.max(0, withSuffixBaseline - host3) * sourceWeight;
    bumpFoundOn(gain.foundOn, record.sourceRegistrableDomain, weights[classIndex] * sourceWeight);
    hostGains.set(record.registrableDomain, gain);
  }

  if (evaluatedUrls % 5_000 === 0) {
    console.error(`Evaluated ${evaluatedUrls.toLocaleString()} held-out URLs`);
  }
}

for (const gain of [...suffixGains.values(), ...compactSuffixGains.values()]) {
  gain.unadjustedGain2 = estimateGain(gain.gain2ByClass, gain.evaluated, gain.classCounts, weights);
  gain.gain2 = gain.unadjustedGain2 * gain.ccTldMultiplier;
}

const rankedSuffixes = [...suffixGains.values()]
  .filter((entry) => entry.gain2 > 0)
  .sort((a, b) => b.gain2 - a.gain2 || a.key.localeCompare(b.key));
const configurations = [];
let best: ReturnType<typeof evaluateConfiguration> | undefined;

for (let twoLeadSymbols = 0; twoLeadSymbols <= EXTENDED_LEADS; twoLeadSymbols += 1) {
  const threeLeadSymbols = EXTENDED_LEADS - twoLeadSymbols;
  const tier2Capacity = Math.floor((twoLeadSymbols * BASE) / STRUCTURAL_STATES);
  const tier3Capacity = Math.floor((threeLeadSymbols * BASE * BASE) / STRUCTURAL_STATES);
  const maxSuffixes = Math.min(tier2Capacity, rankedSuffixes.length, options.maxTier2Suffixes);
  let bestForSplit: ReturnType<typeof evaluateConfiguration> | undefined;

  for (let suffixCount = 0; suffixCount <= maxSuffixes; suffixCount += 1) {
    const configuration = evaluateConfiguration(
      twoLeadSymbols,
      threeLeadSymbols,
      tier2Capacity,
      tier3Capacity,
      rankedSuffixes.slice(0, suffixCount),
      [...hostGains.values()],
    );
    if (!best || configuration.totalScore > best.totalScore) best = configuration;
    if (!bestForSplit || configuration.totalScore > bestForSplit.totalScore) bestForSplit = configuration;
  }
  if (bestForSplit) {
    configurations.push({
      twoLeadSymbols: bestForSplit.twoLeadSymbols,
      threeLeadSymbols: bestForSplit.threeLeadSymbols,
      tier2Capacity: bestForSplit.tier2Capacity,
      tier3Capacity: bestForSplit.tier3Capacity,
      totalScore: bestForSplit.totalScore,
      estimatedCharactersSaved: bestForSplit.estimatedCharactersSaved,
    });
  }
}

if (!best) throw new Error("No header configuration was evaluated");

const result = {
  collection: stats.collection,
  generatedAt: new Date().toISOString(),
  evaluatedUrls,
  baselineCharacters,
  classes: classNames,
  weights: Object.fromEntries(classNames.map((name, index) => [name, weights[index]])),
  sourceWeights: Object.fromEntries(sourceWeights),
  excludedHosts: [...excludedHosts].sort(),
  ccTldWeight: options.ccTldWeight,
  objective: "Score = context-weighted projected ASCII characters saved, with the configured ccTLD multiplier applied to suffix entries",
  classSignals: classNames
    .map((name, index) => ({
      name,
      rawLinks: stats.classTotals?.[index] ?? 0,
      weight: weights[index],
      score: (stats.classTotals?.[index] ?? 0) * weights[index],
    }))
    .sort((a, b) => b.score - a.score || b.rawLinks - a.rawLinks),
  topSources: [...sourceCorpusScores]
    .map(([key, score]) => ({
      key,
      rawLinks: sum(sourceClassCounts.get(key) ?? []),
      score,
      topSignals: summarizeSignals(sourceClassCounts.get(key) ?? [], classNames, weights),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, 100),
  oneCharacter: [...COMPACT_SUFFIXES]
    .map((suffix) => compactSuffixGains.get(suffix))
    .filter((entry): entry is SuffixGain => Boolean(entry))
    .sort((a, b) => b.gain2 - a.gain2)
    .map(suffixResult),
  best,
  leadSplits: configurations.filter(Boolean),
};
writeFileSync(options.outJson, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(options.outMarkdown, renderMarkdown(result));
console.error(`Wrote ${options.outJson}`);
console.error(`Wrote ${options.outMarkdown}`);

function evaluateConfiguration(
  twoLeadSymbols: number,
  threeLeadSymbols: number,
  tier2Capacity: number,
  tier3Capacity: number,
  suffixes: SuffixGain[],
  hosts: Gain[],
) {
  const selectedSuffixes = new Set(suffixes.map((entry) => entry.key));
  const choices: HostChoice[] = hosts.map((host) => ({
    ...host,
    gain2: estimateGain(
      selectedSuffixes.has(host.suffix) ? host.gain2WithSuffix : host.gain2WithoutSuffix,
      host.evaluated,
      host.classCounts,
      weights,
    ),
    gain3: estimateGain(
      selectedSuffixes.has(host.suffix) ? host.gain3WithSuffix : host.gain3WithoutSuffix,
      host.evaluated,
      host.classCounts,
      weights,
    ),
  }));
  const hostTier2Capacity = Math.max(0, tier2Capacity - suffixes.length);
  const initiallyTier3 = new Set(
    [...choices]
      .filter((host) => host.gain3 > 0)
      .sort((a, b) => b.gain3 - a.gain3)
      .slice(0, tier3Capacity)
      .map((host) => host.key),
  );
  const nextTier3Gain = [...choices]
    .filter((host) => !initiallyTier3.has(host.key) && host.gain3 > 0)
    .sort((a, b) => b.gain3 - a.gain3)[0]?.gain3 ?? 0;

  const tier2Hosts = [...choices]
    .map((host) => ({
      ...host,
      promotionScore: initiallyTier3.has(host.key)
        ? host.gain2 - host.gain3 + nextTier3Gain
        : host.gain2,
    }))
    .filter((host) => host.gain2 > 0)
    .sort((a, b) => b.promotionScore - a.promotionScore || b.gain2 - a.gain2)
    .slice(0, hostTier2Capacity);
  const tier2HostKeys = new Set(tier2Hosts.map((host) => host.key));
  const tier3Hosts = choices
    .filter((host) => !tier2HostKeys.has(host.key) && host.gain3 > 0)
    .sort((a, b) => b.gain3 - a.gain3)
    .slice(0, tier3Capacity);

  return {
    twoLeadSymbols,
    threeLeadSymbols,
    tier2Capacity,
    tier3Capacity,
    suffixCount: suffixes.length,
    tier2HostCount: tier2Hosts.length,
    tier3HostCount: tier3Hosts.length,
    totalScore:
      suffixes.reduce((sum, entry) => sum + entry.gain2, 0)
      + tier2Hosts.reduce((sum, entry) => sum + entry.gain2, 0)
      + tier3Hosts.reduce((sum, entry) => sum + entry.gain3, 0),
    estimatedCharactersSaved:
      suffixes.reduce((sum, entry) => sum + entry.unadjustedGain2, 0)
      + tier2Hosts.reduce((sum, entry) => sum + entry.gain2, 0)
      + tier3Hosts.reduce((sum, entry) => sum + entry.gain3, 0),
    suffixes: [...suffixes]
      .sort((a, b) => b.gain2 - a.gain2 || a.key.localeCompare(b.key))
      .map(suffixResult),
    tier2Hosts: [...tier2Hosts]
      .sort((a, b) => b.gain2 - a.gain2 || a.key.localeCompare(b.key))
      .map((host) => hostResult(host, host.gain2)),
    tier3Hosts: [...tier3Hosts]
      .sort((a, b) => b.gain3 - a.gain3 || a.key.localeCompare(b.key))
      .map((host) => hostResult(host, host.gain3)),
  };
}

function newSuffixGain(
  key: string,
  classCounts: Map<string, number[]>,
  corpusCounts: Map<string, number>,
  classCount: number,
  ccTldMultiplier: number,
): SuffixGain {
  return {
    key,
    evaluated: zeros(classCount),
    classCounts: classCounts.get(key) ?? zeros(classCount),
    corpusCount: corpusCounts.get(key) ?? 0,
    gain2ByClass: zeros(classCount),
    gain2: 0,
    unadjustedGain2: 0,
    ccTldMultiplier,
    foundOn: new Map(),
  };
}

function suffixResult(entry: SuffixGain) {
  return {
    key: entry.key,
    rawCount: sum(entry.classCounts),
    weightedCount: entry.corpusCount,
    heldoutMatches: sum(entry.evaluated),
    estimatedCharactersSaved: entry.unadjustedGain2,
    ccTldMultiplier: entry.ccTldMultiplier,
    score: entry.gain2,
    topSignals: summarizeSignals(entry.classCounts, classNames, weights),
    foundOn: summarizeFoundOn(entry.foundOn),
  };
}

function hostResult(entry: HostChoice, score: number) {
  return {
    key: entry.key,
    rawCount: sum(entry.classCounts),
    weightedCount: entry.corpusCount,
    heldoutMatches: sum(entry.evaluated),
    estimatedCharactersSaved: score,
    score,
    topSignals: summarizeSignals(entry.classCounts, classNames, weights),
    foundOn: summarizeFoundOn(entry.foundOn),
  };
}

function estimateGain(gains: number[], evaluated: number[], counts: number[], weights: number[]) {
  return gains.reduce((total, gain, index) => {
    if (evaluated[index] === 0 || counts[index] === 0) return total;
    return total + (gain / evaluated[index]) * counts[index] * weights[index];
  }, 0);
}

function zeros(length: number) {
  return Array.from({ length }, () => 0);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function bumpFoundOn(foundOn: Map<string, number>, rawSource: string | undefined, score: number) {
  const source = rawSource?.toLowerCase() ?? "(unknown)";
  foundOn.set(source, (foundOn.get(source) ?? 0) + score);
}

function summarizeFoundOn(foundOn: Map<string, number>, limit = 3) {
  return [...foundOn]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([source, score]) => ({ source, score }));
}

function summarizeSignals(counts: number[], classes: string[], configuredWeights: number[], limit = 3) {
  return counts
    .map((rawCount, index) => ({
      class: classes[index],
      rawCount,
      weight: configuredWeights[index],
      score: rawCount * configuredWeights[index],
    }))
    .filter((entry) => entry.rawCount > 0 && entry.score > 0)
    .sort((a, b) => b.score - a.score || b.rawCount - a.rawCount)
    .slice(0, limit);
}

function isCountryCodeSuffix(suffix: string) {
  const finalLabel = suffix.toLowerCase().split(".").at(-1) ?? "";
  return /^[a-z]{2}$/.test(finalLabel);
}

function recordWeightClass(record: CorpusRecord, classes: Map<string, number>) {
  const linkClass = record.linkClass ?? "unweighted";
  if (!record.linkPresentation) return linkClass;
  const combined = `${linkClass}/${record.linkPresentation}`;
  return classes.has(combined) ? combined : linkClass;
}

function classCountMap(
  stratified: Array<[string, number[]]> | undefined,
  fallback: Array<[string, number]>,
  classCount: number,
) {
  if (stratified) return new Map(stratified);
  return new Map(fallback.map(([key, count]) => [key, [count, ...zeros(classCount - 1)]]));
}

function weightedCorpusCounts(counts: Map<string, number[]>, weights: number[]) {
  return new Map([...counts].map(([key, values]) => [
    key,
    values.reduce((sum, value, index) => sum + value * weights[index], 0),
  ]));
}

function parseWeights(
  raw: string | undefined,
  classes: string[],
  defaults = zeros(classes.length).map(() => 1),
) {
  const weights = [...defaults];
  if (!raw) return weights;
  for (const assignment of raw.split(",")) {
    const [name, value] = assignment.split("=");
    const index = classes.indexOf(name);
    const number = Number(value);
    if (index === -1) throw new Error(`Unknown link class in --weights: ${name}`);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`Invalid weight for ${name}: ${value}`);
    }
    weights[index] = number;
  }
  return weights;
}

function parseSourceWeights(raw: string | undefined) {
  const weights = new Map<string, number>();
  if (!raw) return weights;
  for (const assignment of raw.split(",")) {
    const [rawName, rawValue] = assignment.split("=");
    const name = rawName?.trim().toLowerCase();
    const value = Number(rawValue);
    if (!name || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid source weight: ${assignment}`);
    }
    weights.set(name, value);
  }
  return weights;
}

function parseHostList(raw: string | undefined) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
}

function residualParts(record: CorpusRecord) {
  let parsed: URL;
  try {
    parsed = new URL(record.url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const credentials = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  const authoritySuffix = parsed.port ? `:${parsed.port}` : "";
  const tail = stripFileEnding(parsed.pathname) + parsed.search + parsed.hash;
  return { authorityPrefix: credentials, authoritySuffix, tail };
}

function stripFileEnding(pathname: string) {
  if (pathname.endsWith("/index.html")) return pathname.slice(0, -"index.html".length);
  if (pathname.endsWith("/index.php")) return pathname.slice(0, -"index.php".length);
  return pathname;
}

function stripSuffix(hostname: string, suffix: string) {
  const ending = `.${suffix}`;
  return hostname.endsWith(ending) ? hostname.slice(0, -ending.length) : hostname;
}

function stripHost(hostname: string, registrableDomain: string) {
  if (hostname === registrableDomain) return "";
  return hostname.endsWith(`.${registrableDomain}`)
    ? hostname.slice(0, -registrableDomain.length)
    : hostname;
}

function payloadLength(body: string) {
  const bitsWithLegacySchemeFlag = encodeTokenStreamV1(tokenize(body), true);
  return encodeTerminatedBits(bitsWithLegacySchemeFlag.slice(1), ASCII_SERVER_ALPHABET).length;
}

async function* readRecords(path: string, limit: number) {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    if (!line) continue;
    yield JSON.parse(line) as CorpusRecord;
    count += 1;
    if (limit !== 0 && count >= limit) break;
  }
}

function renderMarkdown(result: any) {
  const best = result.best;
  const rows = result.leadSplits
    .map((entry: any) => `| ${entry.twoLeadSymbols} | ${entry.threeLeadSymbols} | ${entry.tier2Capacity} | ${entry.tier3Capacity} | ${formatNumber(entry.estimatedCharactersSaved)} | ${formatNumber(entry.totalScore)} |`)
    .join("\n");
  const classSignals = result.classSignals
    .filter((entry: any) => entry.rawLinks > 0)
    .map((entry: any) => `| \`${entry.name}\` | ${formatNumber(entry.rawLinks)} | ${entry.weight} | ${formatNumber(entry.score)} |`)
    .join("\n");
  const topSources = result.topSources
    .map((entry: any) => `| \`${entry.key}\` | ${formatNumber(entry.rawLinks)} | ${formatNumber(entry.score)} | ${renderSignals(entry.topSignals)} |`)
    .join("\n");
  const oneCharacter = [...result.oneCharacter]
    .sort((a: any, b: any) => b.score - a.score)
    .map((entry: any) => renderChoiceRow("suffix", entry))
    .join("\n");
  const twoCharacter = [
    ...best.suffixes.map((entry: any) => ({ kind: "suffix", ...entry })),
    ...best.tier2Hosts.map((entry: any) => ({ kind: "host", ...entry })),
  ]
    .sort((a: any, b: any) => b.score - a.score || a.key.localeCompare(b.key))
    .map((entry: any) => renderChoiceRow(entry.kind, entry))
    .join("\n");
  const threeCharacter = [...best.tier3Hosts]
    .sort((a: any, b: any) => b.score - a.score || a.key.localeCompare(b.key))
    .map((entry: any) => renderChoiceRow("host", entry))
    .join("\n");
  const choiceHeader = "| entry | kind | raw links | weighted links | dominant training signals | held-out links found on | est. chars saved | ccTLD weight | score |\n| --- | --- | ---: | ---: | --- | --- | ---: | ---: | ---: |";
  return `# Variable header optimization\n\nCorpus: \`${result.collection}\`  \nHeld-out URLs evaluated: ${formatNumber(result.evaluatedUrls)}  \nObjective: ${result.objective}  \nccTLD score multiplier: **${result.ccTldWeight}** (applies when a public suffix ends in a two-letter country code)  \nExcluded host symbols: ${result.excludedHosts.map((host: string) => `\`${host}\``).join(", ")}\n\nThe raw count is retained for auditability, but allocation is sorted by **score**, not count. Context weights make visible links found in social posts, profiles, forums, and editorial pages worth more than generic web links; masked and textless links currently score zero. Character gain naturally rewards longer hosts/suffixes, then the ccTLD multiplier mildly deprioritizes localized suffixes.\n\n## Training signal weights\n\n| signal | raw links | weight | weighted-link score |\n| --- | ---: | ---: | ---: |\n${classSignals}\n\n## Links found on\n\nTop source sites, sorted by context-weighted score. Exact per-candidate source sites also appear in each shortlist.\n\n| source site | raw outgoing links | weighted-link score | dominant signals |\n| --- | ---: | ---: | --- |\n${topSources}\n\n## Recommended allocation\n\n- Two-character lead symbols: **${best.twoLeadSymbols}**\n- Three-character lead symbols: **${best.threeLeadSymbols}**\n- Tier-two capacity: **${best.tier2Capacity}** entries\n- Tier-three capacity: **${best.tier3Capacity}** entries\n- Selected two-character suffixes: **${best.suffixCount}**\n- Selected two-character hosts: **${best.tier2HostCount}**\n- Selected three-character hosts: **${best.tier3HostCount}**\n- Final score: **${formatNumber(best.totalScore)}**\n- Unadjusted estimated characters saved: **${formatNumber(best.estimatedCharactersSaved)}**\n\n## Lead split comparison\n\n| 2-char leads | 3-char leads | tier-2 capacity | tier-3 capacity | est. chars saved | final score |\n| ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n## One-character shortlist\n\nThese three compact suffix states are fixed, alongside the raw-host fallback.\n\n${choiceHeader}\n${oneCharacter}\n\n## Two-character shortlist\n\nComplete selected suffix and host allocation, sorted by score.\n\n${choiceHeader}\n${twoCharacter}\n\n## Three-character shortlist\n\nComplete selected host allocation, sorted by score.\n\n${choiceHeader}\n${threeCharacter}\n`;
}

function renderChoiceRow(kind: string, entry: any) {
  return `| \`${entry.key}\` | ${kind} | ${formatNumber(entry.rawCount)} | ${formatNumber(entry.weightedCount)} | ${renderSignals(entry.topSignals)} | ${renderFoundOn(entry.foundOn)} | ${formatNumber(entry.estimatedCharactersSaved)} | ${entry.ccTldMultiplier ?? 1} | ${formatNumber(entry.score)} |`;
}

function renderSignals(signals: any[]) {
  return signals.length === 0
    ? "—"
    : signals.map((entry) => `\`${entry.class}\` ×${entry.weight} (${formatNumber(entry.rawCount)})`).join("<br>");
}

function renderFoundOn(sources: any[]) {
  return sources.length === 0
    ? "—"
    : sources.map((entry) => `\`${entry.source}\` (${formatNumber(entry.score)})`).join("<br>");
}

function formatNumber(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  const collection = values.get("--collection") ?? "CC-MAIN-2026-30";
  const root = `data/commoncrawl/${collection}`;
  return {
    stats: resolve(values.get("--stats") ?? `${root}/header-corpus-stats.json`),
    heldout: resolve(values.get("--heldout") ?? `${root}/header-heldout.jsonl.gz`),
    outJson: resolve(values.get("--out-json") ?? `${root}/header-optimization.json`),
    outMarkdown: resolve(values.get("--out-markdown") ?? `${root}/header-optimization.md`),
    hostCandidates: Number(values.get("--host-candidates") ?? 10_000),
    suffixCandidates: Number(values.get("--suffix-candidates") ?? 512),
    limitUrls: Number(values.get("--limit-urls") ?? 50_000),
    maxTier2Suffixes: Number(values.get("--max-tier2-suffixes") ?? 81),
    weights: values.get("--weights"),
    sourceWeights: values.get("--source-weights"),
    excludeHosts: values.get("--exclude-hosts"),
    ccTldWeight: Number(values.get("--cc-tld-weight") ?? 0.85),
  };
}
