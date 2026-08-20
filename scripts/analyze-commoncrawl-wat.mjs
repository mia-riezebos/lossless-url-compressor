import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { domainToASCII } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";

const WEIGHT_SCALE = 4;
const MAX_HOSTS_PER_WORKER = 250_000;
const MAX_SOURCE_HOSTS_PER_WORKER = 100_000;
const MAX_ANCHORS_PER_PAGE = 20_000;
const MAX_WEIGHTED_LINKS_PER_DOMAIN_PER_PAGE = 3;

if (isMainThread) {
  await main();
} else {
  await scanFiles(workerData);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = discoverWatFiles(options.input, options.limitFiles);
  if (files.length === 0) throw new Error(`No .warc.wat.gz files found under ${options.input}`);
  if (!existsSync(options.psl)) throw new Error(`Public Suffix List is missing: ${options.psl}`);

  mkdirSync(options.output, { recursive: true });
  const startedAt = Date.now();
  const workerCount = Math.max(1, Math.min(options.threads, files.length));
  const assignments = Array.from({ length: workerCount }, () => []);
  files.forEach((file, index) => assignments[index % workerCount].push(file));
  const progressByWorker = new Map();

  console.error(`Streaming ${files.length.toLocaleString()} WAT files with ${workerCount} workers`);
  const results = await Promise.all(assignments.map((assignedFiles, workerIndex) => new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        files: assignedFiles,
        workerIndex,
        psl: options.psl,
        heldoutLimit: Math.ceil(options.heldoutUrls / workerCount),
      },
    });
    worker.on("message", (message) => {
      if (message.type === "progress") {
        progressByWorker.set(workerIndex, message);
        const progress = aggregateProgress(progressByWorker.values());
        const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
        const rateMiB = progress.compressedBytes / 1024 ** 2 / elapsedSeconds;
        console.error(
          `${progress.files}/${files.length} files | ${(progress.compressedBytes / 1024 ** 3).toFixed(1)} GiB | `
          + `${progress.pages.toLocaleString()} pages | ${progress.eligibleLinks.toLocaleString()} links | ${rateMiB.toFixed(1)} MiB/s`,
        );
        writeFileSync(options.progress, `${JSON.stringify({ ...progress, totalFiles: files.length, elapsedSeconds, rateMiB }, null, 2)}\n`);
      } else if (message.type === "result") {
        resolveWorker(message.result);
      }
    });
    worker.on("error", rejectWorker);
    worker.on("exit", (code) => {
      if (code !== 0) rejectWorker(new Error(`WAT worker ${workerIndex} exited with code ${code}`));
    });
  })));

  const merged = mergeResults(results);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const report = {
    collection: options.collection,
    generatedAt: new Date().toISOString(),
    input: options.input,
    files: files.length,
    compressedBytes: merged.totals.compressedBytes,
    elapsedSeconds,
    weightScale: WEIGHT_SCALE,
    weighting: {
      genericExternal: 4,
      socialPostExternal: 32,
      socialProfileExternal: 24,
      forumPostExternal: 20,
      forumExternal: 12,
      videoExternal: 12,
      blogOrNewsExternal: 8,
      internal: 1,
      directoryPageExternal: 2,
      maxWeightedLinksPerTargetDomainPerSourcePage: MAX_WEIGHTED_LINKS_PER_DOMAIN_PER_PAGE,
    },
    totals: merged.totals,
    sourceSurfaces: topEntries(merged.sourceSurfaces, 100),
    linkElementPaths: topEntries(merged.linkPaths, 100),
    linkRelations: topEntries(merged.relations, 100),
    targetSchemes: topEntries(merged.schemes, 20),
    targetSuffixes: summarizeTargetCounter(merged.suffixes, options.topSuffixes),
    targetHosts: summarizeTargetCounter(merged.hosts, options.topHosts),
    sourceHosts: topEntries(merged.sourceHosts, options.topSourceHosts),
  };

  const headerStats = {
    collection: options.collection,
    generatedAt: report.generatedAt,
    source: "Common Crawl WAT A@/href targets, source-context weighted",
    weightScale: WEIGHT_SCALE,
    rowsSampled: merged.totals.eligibleLinks,
    supportedUrls: merged.totals.weightedLinks,
    topSuffixes: topEntries(projectMetric(merged.suffixes, "weighted"), options.topSuffixes),
    topHosts: topEntries(projectMetric(merged.hosts, "weighted"), options.topHosts),
  };

  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(options.headerStats, `${JSON.stringify(headerStats, null, 2)}\n`);
  writeFileSync(options.markdown, renderMarkdown(report));
  await writeHeldout(options.heldout, merged.heldout.slice(0, options.heldoutUrls));
  writeFileSync(options.progress, `${JSON.stringify({ status: "complete", files: files.length, ...merged.totals, elapsedSeconds }, null, 2)}\n`);

  console.error(`Wrote ${options.report}`);
  console.error(`Wrote ${options.headerStats}`);
  console.error(`Wrote ${options.heldout}`);
}

async function scanFiles({ files, workerIndex, psl, heldoutLimit }) {
  const rules = loadPublicSuffixList(psl);
  const counters = {
    hosts: new Map(),
    suffixes: new Map(),
    sourceHosts: new Map(),
    sourceSurfaces: new Map(),
    linkPaths: new Map(),
    relations: new Map(),
    schemes: new Map(),
  };
  const totals = emptyTotals();
  const heldout = [];
  let heldoutWeight = 0;
  const random = xorshift32((workerIndex + 1) * 0x9e3779b1);

  for (const file of files) {
    await scanFile(file, rules, counters, totals, (record, weight) => {
      heldoutWeight += weight;
      if (heldout.length < heldoutLimit) {
        heldout.push(record);
        return;
      }
      if (random() < heldoutLimit * weight / heldoutWeight) {
        heldout[Math.floor(random() * heldoutLimit)] = record;
      }
    });
    totals.files += 1;
    totals.compressedBytes += file.bytes;
    pruneMetricCounter(counters.hosts, MAX_HOSTS_PER_WORKER);
    pruneCounter(counters.sourceHosts, MAX_SOURCE_HOSTS_PER_WORKER);
    parentPort.postMessage({ type: "progress", ...totals, currentFile: basename(file.path) });
  }

  parentPort.postMessage({
    type: "result",
    result: {
      totals,
      hosts: metricEntries(counters.hosts, MAX_HOSTS_PER_WORKER),
      suffixes: metricEntries(counters.suffixes, 10_000),
      sourceHosts: topEntries(counters.sourceHosts, MAX_SOURCE_HOSTS_PER_WORKER),
      sourceSurfaces: topEntries(counters.sourceSurfaces, 1_000),
      linkPaths: topEntries(counters.linkPaths, 1_000),
      relations: topEntries(counters.relations, 1_000),
      schemes: topEntries(counters.schemes, 100),
      heldout,
    },
  });
}

async function scanFile(file, rules, counters, totals, addHeldout) {
  const input = createReadStream(file.path).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.startsWith('{"Container"')) continue;
    totals.metadataRecords += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      totals.invalidJson += 1;
      continue;
    }

    const envelope = record.Envelope;
    const payload = envelope?.["Payload-Metadata"];
    const response = payload?.["HTTP-Response-Metadata"];
    const links = response?.["HTML-Metadata"]?.Links;
    if (!Array.isArray(links)) continue;

    const sourceUrlText = envelope?.["WARC-Header-Metadata"]?.["WARC-Target-URI"];
    const source = parseHttpUrl(sourceUrlText);
    if (!source) continue;
    const sourceIdentity = domainIdentity(source.hostname, rules);
    if (!sourceIdentity) continue;

    totals.pages += 1;
    const surface = classifySourceSurface(sourceIdentity.registrableDomain, source.pathname);
    bump(counters.sourceSurfaces, surface, 1);
    bump(counters.sourceHosts, sourceIdentity.registrableDomain, 1);

    const targets = [];
    const seenUrls = new Set();
    let internalAnchors = 0;
    for (const link of links) {
      const elementPath = typeof link?.path === "string" ? link.path : "unknown";
      bump(counters.linkPaths, elementPath, 1);
      addRelations(counters.relations, link?.rel);
      if (elementPath !== "A@/href" && elementPath !== "AREA@/href") continue;
      totals.anchorLinks += 1;
      if (targets.length >= MAX_ANCHORS_PER_PAGE) {
        totals.pagesWithTruncatedLinks += 1;
        break;
      }

      const target = resolveHttpUrl(link?.url, source);
      if (!target || seenUrls.has(target.href)) continue;
      seenUrls.add(target.href);
      const targetIdentity = domainIdentity(target.hostname, rules);
      if (!targetIdentity) continue;
      const internal = targetIdentity.registrableDomain === sourceIdentity.registrableDomain;
      if (internal) internalAnchors += 1;
      targets.push({ target, identity: targetIdentity, internal });
    }

    if (targets.length === 0) continue;
    totals.pagesWithEligibleLinks += 1;
    const internalRatio = internalAnchors / targets.length;
    const directoryPage = targets.length >= 200 && internalRatio >= 0.8;
    if (directoryPage) totals.directoryPages += 1;
    const weightedPerDomain = new Map();

    for (const { target, identity, internal } of targets) {
      totals.eligibleLinks += 1;
      if (!internal) totals.externalLinks += 1;
      const metrics = getMetric(counters.hosts, identity.registrableDomain);
      metrics.raw += 1;
      if (!internal) metrics.external += 1;
      const suffixMetrics = getMetric(counters.suffixes, identity.suffix);
      suffixMetrics.raw += 1;
      if (!internal) suffixMetrics.external += 1;
      bump(counters.schemes, target.protocol.slice(0, -1), 1);

      const usedForDomain = weightedPerDomain.get(identity.registrableDomain) ?? 0;
      if (usedForDomain >= MAX_WEIGHTED_LINKS_PER_DOMAIN_PER_PAGE) {
        totals.weightCapExcluded += 1;
        continue;
      }
      weightedPerDomain.set(identity.registrableDomain, usedForDomain + 1);
      const weight = linkWeight(surface, internal, directoryPage);
      metrics.weighted += weight;
      suffixMetrics.weighted += weight;
      totals.weightedLinks += weight;

      const hostname = normalizeHostname(target.hostname);
      const hasWww = hostname.startsWith("www.");
      addHeldout({
        url: target.href,
        hostname: hasWww ? hostname.slice(4) : hostname,
        suffix: identity.suffix,
        registrableDomain: identity.registrableDomain,
        hasWww,
        sourceSurface: surface,
        internal,
        weight,
      }, weight);
    }
  }
}

function mergeResults(results) {
  const merged = {
    totals: emptyTotals(),
    hosts: new Map(),
    suffixes: new Map(),
    sourceHosts: new Map(),
    sourceSurfaces: new Map(),
    linkPaths: new Map(),
    relations: new Map(),
    schemes: new Map(),
    heldout: [],
  };
  for (const result of results) {
    for (const [key, value] of Object.entries(result.totals)) merged.totals[key] += value;
    mergeMetricEntries(merged.hosts, result.hosts);
    mergeMetricEntries(merged.suffixes, result.suffixes);
    mergeEntries(merged.sourceHosts, result.sourceHosts);
    mergeEntries(merged.sourceSurfaces, result.sourceSurfaces);
    mergeEntries(merged.linkPaths, result.linkPaths);
    mergeEntries(merged.relations, result.relations);
    mergeEntries(merged.schemes, result.schemes);
    merged.heldout.push(...result.heldout);
  }
  pruneMetricCounter(merged.hosts, 500_000);
  return merged;
}

function emptyTotals() {
  return {
    files: 0,
    compressedBytes: 0,
    metadataRecords: 0,
    invalidJson: 0,
    pages: 0,
    pagesWithEligibleLinks: 0,
    pagesWithTruncatedLinks: 0,
    directoryPages: 0,
    anchorLinks: 0,
    eligibleLinks: 0,
    externalLinks: 0,
    weightedLinks: 0,
    weightCapExcluded: 0,
  };
}

function classifySourceSurface(host, pathname) {
  const path = pathname.toLowerCase();
  if (host === "x.com" || host === "twitter.com") return /\/status\/\d+/.test(path) ? "social-post" : "social-profile";
  if (host === "instagram.com") return /^\/(?:p|reel|reels|tv)\//.test(path) ? "social-post" : "social-profile";
  if (host === "facebook.com" || host === "fb.com") return /\/(?:posts|videos|photos|permalink|story\.php)/.test(path) ? "social-post" : "social-profile";
  if (host === "threads.net" || host === "bsky.app" || host.endsWith("mastodon.social")) return "social-post";
  if (host === "reddit.com") return /\/comments\//.test(path) ? "forum-post" : "forum";
  if (host === "tiktok.com" || host === "youtube.com" || host === "youtu.be" || host === "vimeo.com") return "video";
  if (/forum|forums|community|discuss/.test(host) || /\/(?:forum|forums|thread|threads|topic|topics)\//.test(path)) return "forum";
  if (/news|blog/.test(host) || /\/(?:news|blog|article|articles)\//.test(path)) return "blog-news";
  return "web";
}

function linkWeight(surface, internal, directoryPage) {
  if (internal) return 1;
  if (directoryPage) return 2;
  if (surface === "social-post") return 32;
  if (surface === "social-profile") return 24;
  if (surface === "forum-post") return 20;
  if (surface === "forum") return 12;
  if (surface === "video") return 12;
  if (surface === "blog-news") return 8;
  return 4;
}

function resolveHttpUrl(rawUrl, source) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 16_384) return undefined;
  try {
    const target = new URL(rawUrl, source);
    if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
    target.hostname = normalizeHostname(target.hostname);
    return target;
  } catch {
    return undefined;
  }
}

function parseHttpUrl(rawUrl) {
  if (typeof rawUrl !== "string") return undefined;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeHostname(hostname) {
  return domainToASCII(hostname).toLowerCase().replace(/\.$/, "");
}

function domainIdentity(rawHostname, rules) {
  const hostname = normalizeHostname(rawHostname).replace(/^www\./, "");
  if (!hostname || hostname.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(hostname)) return undefined;
  const suffix = publicSuffix(hostname, rules);
  const labels = hostname.split(".");
  const suffixLabels = suffix.split(".");
  if (labels.length <= suffixLabels.length) return undefined;
  return { suffix, registrableDomain: labels.slice(-(suffixLabels.length + 1)).join(".") };
}

function loadPublicSuffixList(path) {
  const exact = new Set();
  const wildcard = new Set();
  const exception = new Set();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    const target = line.startsWith("!") ? exception : line.startsWith("*.") ? wildcard : exact;
    const ascii = domainToASCII(line.replace(/^!|^\*\./, "")).toLowerCase();
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
    if (index > 0 && rules.wildcard.has(candidate)) matchLength = Math.max(matchLength, labels.length - index + 1);
  }
  return labels.slice(-matchLength).join(".");
}

function getMetric(counter, key) {
  let value = counter.get(key);
  if (!value) {
    value = { weighted: 0, external: 0, raw: 0 };
    counter.set(key, value);
  }
  return value;
}

function bump(counter, key, amount) {
  if (!key || key.length > 255) return;
  counter.set(key, (counter.get(key) ?? 0) + amount);
}

function addRelations(counter, relation) {
  if (Array.isArray(relation)) {
    for (const value of relation) bump(counter, String(value).toLowerCase(), 1);
  } else if (typeof relation === "string") {
    for (const value of relation.toLowerCase().split(/\s+/)) bump(counter, value, 1);
  }
}

function pruneMetricCounter(counter, limit) {
  if (counter.size <= limit * 2) return;
  const keep = new Set(metricEntries(counter, limit).map(([key]) => key));
  for (const key of counter.keys()) if (!keep.has(key)) counter.delete(key);
}

function pruneCounter(counter, limit) {
  if (counter.size <= limit * 2) return;
  const keep = new Set(topEntries(counter, limit).map(([key]) => key));
  for (const key of counter.keys()) if (!keep.has(key)) counter.delete(key);
}

function metricEntries(counter, limit) {
  return [...counter.entries()]
    .sort((a, b) => b[1].weighted - a[1].weighted || b[1].external - a[1].external || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function topEntries(counter, limit) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function mergeMetricEntries(counter, entries) {
  for (const [key, value] of entries) {
    const target = getMetric(counter, key);
    target.weighted += value.weighted;
    target.external += value.external;
    target.raw += value.raw;
  }
}

function mergeEntries(counter, entries) {
  for (const [key, value] of entries) bump(counter, key, value);
}

function projectMetric(counter, metric) {
  return new Map([...counter.entries()].map(([key, value]) => [key, value[metric]]));
}

function summarizeTargetCounter(counter, limit) {
  return metricEntries(counter, limit).map(([key, value]) => ({ key, ...value }));
}

function aggregateProgress(progresses) {
  const result = emptyTotals();
  for (const progress of progresses) {
    for (const key of Object.keys(result)) result[key] += progress[key] ?? 0;
  }
  return result;
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

function renderMarkdown(report) {
  const targetHosts = report.targetHosts.slice(0, 100).map((entry) =>
    `| \`${entry.key}\` | ${entry.weighted.toLocaleString()} | ${entry.external.toLocaleString()} | ${entry.raw.toLocaleString()} |`,
  ).join("\n");
  const suffixes = report.targetSuffixes.slice(0, 100).map((entry) =>
    `| \`${entry.key}\` | ${entry.weighted.toLocaleString()} | ${entry.external.toLocaleString()} | ${entry.raw.toLocaleString()} |`,
  ).join("\n");
  const surfaces = report.sourceSurfaces.map(([key, value]) => `| \`${key}\` | ${value.toLocaleString()} |`).join("\n");
  return `# Common Crawl WAT link analysis\n\n`
    + `Collection: \`${report.collection}\`  \nFiles: ${report.files.toLocaleString()}  \n`
    + `Compressed input: ${(report.compressedBytes / 1024 ** 3).toFixed(2)} GiB  \n`
    + `HTML pages: ${report.totals.pages.toLocaleString()}  \nEligible unique links: ${report.totals.eligibleLinks.toLocaleString()}  \n`
    + `External links: ${report.totals.externalLinks.toLocaleString()}  \nWeight scale: ${report.weightScale}\n\n`
    + `## Source surfaces\n\n| surface | pages |\n| --- | ---: |\n${surfaces}\n\n`
    + `## Target public suffixes\n\n| suffix | weighted units | external links | raw links |\n| --- | ---: | ---: | ---: |\n${suffixes}\n\n`
    + `## Target registrable hosts\n\n| host | weighted units | external links | raw links |\n| --- | ---: | ---: | ---: |\n${targetHosts}\n`;
}

function discoverWatFiles(input, limit) {
  const stack = [input];
  const files = [];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readDirectory(directory)) {
      if (entry.isDirectory()) stack.push(join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".warc.wat.gz")) {
        const path = join(directory, entry.name);
        files.push({ path, bytes: readFileSize(path) });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return limit === 0 ? files : files.slice(0, limit);
}

function readDirectory(path) {
  return readdirSync(path, { withFileTypes: true });
}

function readFileSize(path) {
  return statSync(path).size;
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

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  const input = resolve(values.get("--input") ?? "N:/mia/commoncrawl/CC-MAIN-2026-30/wat");
  const output = resolve(values.get("--output") ?? "N:/mia/commoncrawl/CC-MAIN-2026-30/analysis");
  return {
    collection: values.get("--collection") ?? "CC-MAIN-2026-30",
    input,
    output,
    psl: resolve(values.get("--psl") ?? "data/publicsuffix/public_suffix_list.dat"),
    report: resolve(values.get("--report") ?? join(output, "wat-analysis.json")),
    markdown: resolve(values.get("--markdown") ?? join(output, "wat-analysis.md")),
    progress: resolve(values.get("--progress") ?? join(output, "wat-analysis-progress.json")),
    headerStats: resolve(values.get("--header-stats") ?? join(output, "header-corpus-stats.json")),
    heldout: resolve(values.get("--heldout") ?? join(output, "header-heldout.jsonl.gz")),
    threads: Number(values.get("--threads") ?? Math.min(8, cpus().length)),
    limitFiles: Number(values.get("--limit-files") ?? 0),
    heldoutUrls: Number(values.get("--heldout-urls") ?? 200_000),
    topHosts: Number(values.get("--top-hosts") ?? 100_000),
    topSuffixes: Number(values.get("--top-suffixes") ?? 5_000),
    topSourceHosts: Number(values.get("--top-source-hosts") ?? 50_000),
  };
}
