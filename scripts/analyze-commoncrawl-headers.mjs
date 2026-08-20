import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { domainToASCII } from "node:url";

const DEFAULT_COLLECTION = "CC-MAIN-2026-30";
const DEFAULT_SAMPLE_EVERY = 100;
const DEFAULT_HELDOUT_URLS = 200_000;
const DEFAULT_TOP_HOSTS = 50_000;
const DEFAULT_TOP_SUFFIXES = 2_000;
const MAX_WORKER_HOSTS = 250_000;

if (isMainThread) {
  await main();
} else {
  await scanShard(workerData);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const shardDir = resolve(options.shards);
  const discoveredFiles = readdirSync(shardDir)
    .filter((name) => name.startsWith("cdx-") && name.endsWith(".gz"))
    .sort()
    .map((name) => join(shardDir, name));
  const files = options.limitShards === 0 ? discoveredFiles : discoveredFiles.slice(0, options.limitShards);

  if (files.length === 0) throw new Error(`No CDXJ shards found in ${shardDir}`);
  if (!existsSync(options.psl)) throw new Error(`Public Suffix List not found: ${options.psl}`);

  mkdirSync(dirname(options.out), { recursive: true });
  const heldoutPerShard = Math.ceil(options.heldoutUrls / files.length);
  const workers = Math.max(1, Math.min(options.threads, files.length));
  const queue = [...files.entries()];
  const suffixes = new Map();
  const hosts = new Map();
  const heldout = [];
  let rowsSeen = 0;
  let rowsSampled = 0;
  let supportedUrls = 0;
  let active = 0;
  let completed = 0;

  console.error(`Scanning ${files.length} shards with ${workers} workers (sample every ${options.sampleEvery} rows)`);

  await new Promise((resolveDone, reject) => {
    const launch = () => {
      while (active < workers && queue.length > 0) {
        const [shardIndex, file] = queue.shift();
        active += 1;
        const worker = new Worker(new URL(import.meta.url), {
          workerData: {
            file,
            shardIndex,
            sampleEvery: options.sampleEvery,
            heldoutEvery: options.heldoutEvery,
            heldoutLimit: heldoutPerShard,
            psl: options.psl,
          },
        });

        worker.on("message", (message) => {
          if (message.type === "progress") {
            console.error(`${basename(file)}: seen=${message.seen.toLocaleString()} sampled=${message.sampled.toLocaleString()}`);
            return;
          }

          rowsSeen += message.seen;
          rowsSampled += message.sampled;
          supportedUrls += message.supported;
          mergeCounter(suffixes, message.suffixes);
          mergeCounter(hosts, message.hosts);
          heldout.push(...message.heldout);
          active -= 1;
          completed += 1;
          console.error(`Completed ${completed}/${files.length}: ${basename(file)}`);
          launch();
          if (completed === files.length) resolveDone();
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`Worker exited with code ${code}: ${file}`));
        });
      }
    };
    launch();
  });

  const topSuffixes = topEntries(suffixes, options.topSuffixes);
  const topHosts = topEntries(hosts, options.topHosts);
  const report = {
    collection: options.collection,
    generatedAt: new Date().toISOString(),
    shardDirectory: shardDir,
    shards: files.length,
    compressedBytes: files.reduce((sum, file) => sum + readFileSize(file), 0),
    sampleEvery: options.sampleEvery,
    rowsSeen,
    rowsSampled,
    supportedUrls,
    heldoutUrls: heldout.length,
    publicSuffixList: resolve(options.psl),
    topSuffixes,
    topHosts,
  };

  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  await writeHeldout(options.heldoutOut, heldout);
  console.error(`Wrote ${options.out}`);
  console.error(`Wrote ${options.heldoutOut} (${heldout.length.toLocaleString()} URLs)`);
}

async function scanShard({ file, shardIndex, sampleEvery, heldoutEvery, heldoutLimit, psl }) {
  const rules = loadPublicSuffixList(psl);
  const suffixes = new Map();
  const hosts = new Map();
  const heldout = [];
  const random = xorshift32((shardIndex + 1) * 0x9e3779b1);
  let heldoutSeen = 0;
  let seen = 0;
  let sampled = 0;
  let supported = 0;

  const input = createReadStream(file).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    seen += 1;
    if (seen % sampleEvery !== 0) continue;
    sampled += 1;
    const rawUrl = extractUrl(line);
    if (!rawUrl) continue;
    const record = parseRecord(rawUrl, rules);
    if (!record) continue;
    supported += 1;

    bump(suffixes, record.suffix);
    bump(hosts, record.registrableDomain);

    if (sampled % heldoutEvery === 0) {
      heldoutSeen += 1;
      if (heldout.length < heldoutLimit) {
        heldout.push(record);
      } else {
        const replacement = Math.floor(random() * heldoutSeen);
        if (replacement < heldoutLimit) heldout[replacement] = record;
      }
    }

    if (hosts.size > MAX_WORKER_HOSTS * 2) pruneCounter(hosts, MAX_WORKER_HOSTS);
    if (seen % 25_000_000 === 0) {
      parentPort.postMessage({ type: "progress", seen, sampled });
    }
  }

  parentPort.postMessage({
    type: "result",
    seen,
    sampled,
    supported,
    suffixes: topEntries(suffixes, 10_000),
    hosts: topEntries(hosts, MAX_WORKER_HOSTS),
    heldout,
  });
}

function parseRecord(rawUrl, rules) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  let hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(hostname)) return undefined;
  const hasWww = hostname.startsWith("www.");
  if (hasWww) hostname = hostname.slice(4);

  const suffix = publicSuffix(hostname, rules);
  const registrableDomain = registrable(hostname, suffix);
  if (!suffix || !registrableDomain) return undefined;

  return {
    url: rawUrl,
    hostname,
    suffix,
    registrableDomain,
    hasWww,
  };
}

function extractUrl(line) {
  const firstSpace = line.indexOf(" ");
  if (firstSpace === -1) return undefined;
  const secondSpace = line.indexOf(" ", firstSpace + 1);
  if (secondSpace === -1) return undefined;
  try {
    const metadata = JSON.parse(line.slice(secondSpace + 1));
    return typeof metadata.url === "string" ? metadata.url : undefined;
  } catch {
    return undefined;
  }
}

function loadPublicSuffixList(path) {
  const exact = new Set();
  const wildcard = new Set();
  const exception = new Set();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    const target = line.startsWith("!") ? exception : line.startsWith("*.") ? wildcard : exact;
    const rule = line.replace(/^!|^\*\./, "");
    const ascii = domainToASCII(rule).toLowerCase();
    if (ascii) target.add(ascii);
  }
  return { exact, wildcard, exception };
}

function publicSuffix(hostname, rules) {
  const labels = hostname.split(".");
  let matchLength = 1;
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join(".");
    if (rules.exception.has(candidate)) return labels.slice(index + 1).join(".");
    if (rules.exact.has(candidate)) matchLength = Math.max(matchLength, labels.length - index);
    if (index > 0 && rules.wildcard.has(candidate)) {
      matchLength = Math.max(matchLength, labels.length - index + 1);
    }
  }
  return labels.slice(-matchLength).join(".");
}

function registrable(hostname, suffix) {
  const hostLabels = hostname.split(".");
  const suffixLabels = suffix.split(".");
  if (hostLabels.length <= suffixLabels.length) return undefined;
  return hostLabels.slice(-(suffixLabels.length + 1)).join(".");
}

function bump(counter, value) {
  if (!value || value.length > 255) return;
  counter.set(value, (counter.get(value) ?? 0) + 1);
}

function mergeCounter(counter, entries) {
  for (const [value, count] of entries) {
    counter.set(value, (counter.get(value) ?? 0) + count);
  }
  if (counter.size > 1_000_000) pruneCounter(counter, 500_000);
}

function pruneCounter(counter, limit) {
  const keep = new Set(topEntries(counter, limit).map(([value]) => value));
  for (const value of counter.keys()) {
    if (!keep.has(value)) counter.delete(value);
  }
}

function topEntries(counter, limit) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function xorshift32(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

async function writeHeldout(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(path);
  const source = async function* () {
    for (const record of records) yield `${JSON.stringify(record)}\n`;
  };
  await pipeline(source(), gzip, output);
}

function readFileSize(path) {
  return statSync(path).size;
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    values.set(args[index], args[index + 1]);
  }
  const collection = values.get("--collection") ?? DEFAULT_COLLECTION;
  const root = resolve(`data/commoncrawl/${collection}`);
  return {
    collection,
    shards: values.get("--shards") ?? join(root, "shards"),
    psl: resolve(values.get("--psl") ?? "data/publicsuffix/public_suffix_list.dat"),
    out: resolve(values.get("--out") ?? join(root, "header-corpus-stats.json")),
    heldoutOut: resolve(values.get("--heldout-out") ?? join(root, "header-heldout.jsonl.gz")),
    sampleEvery: Number(values.get("--sample-every") ?? DEFAULT_SAMPLE_EVERY),
    heldoutEvery: Number(values.get("--heldout-every") ?? 10),
    heldoutUrls: Number(values.get("--heldout-urls") ?? DEFAULT_HELDOUT_URLS),
    topHosts: Number(values.get("--top-hosts") ?? DEFAULT_TOP_HOSTS),
    topSuffixes: Number(values.get("--top-suffixes") ?? DEFAULT_TOP_SUFFIXES),
    threads: Number(values.get("--threads") ?? Math.min(8, availableParallelism())),
    limitShards: Number(values.get("--limit-shards") ?? 0),
  };
}
