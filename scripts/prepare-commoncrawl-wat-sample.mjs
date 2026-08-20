import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
const paths = readGzipLines(options.manifest);
if (paths.length === 0) throw new Error(`Manifest is empty: ${options.manifest}`);

mkdirSync(options.outDir, { recursive: true });
const candidateCount = Math.min(paths.length, options.candidates);
const candidateIndices = spacedIndices(paths.length, candidateCount);

console.error(`Fetching sizes for ${candidateCount.toLocaleString()} evenly spaced WAT candidates`);
const candidates = await concurrentMap(candidateIndices, options.concurrency, async (index, completed) => {
  const path = paths[index];
  const bytes = await contentLength(`${options.baseUrl}/${path}`, options.retries);
  if (completed % 100 === 0) console.error(`Sized ${completed.toLocaleString()}/${candidateCount.toLocaleString()}`);
  return { index, path, bytes };
});

const targetBytes = options.targetGiB * 1024 ** 3;
const averageBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0) / candidates.length;
let selectedCount = Math.max(1, Math.min(candidates.length, Math.round(targetBytes / averageBytes)));
let selected = [];

for (let iteration = 0; iteration < 8; iteration += 1) {
  selected = spacedIndices(candidates.length, selectedCount).map((index) => candidates[index]);
  const selectedBytes = selected.reduce((sum, candidate) => sum + candidate.bytes, 0);
  const adjustedCount = Math.max(
    1,
    Math.min(candidates.length, Math.round(selectedCount * targetBytes / selectedBytes)),
  );
  if (adjustedCount === selectedCount) break;
  selectedCount = adjustedCount;
}

const selectedBytes = selected.reduce((sum, candidate) => sum + candidate.bytes, 0);
const records = selected.map((candidate) => {
  const segment = segmentFromPath(candidate.path);
  const output = join(options.outDir, segment, basename(candidate.path));
  mkdirSync(dirname(output), { recursive: true });
  return {
    ...candidate,
    url: `${options.baseUrl}/${candidate.path}`,
    output,
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  manifest: options.manifest,
  manifestEntries: paths.length,
  candidateCount,
  selectedCount: records.length,
  selectedBytes,
  selectedGiB: selectedBytes / 1024 ** 3,
  targetGiB: options.targetGiB,
  firstManifestIndex: records[0]?.index,
  lastManifestIndex: records.at(-1)?.index,
  records,
};

writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  options.tsv,
  ["manifest_index\tbytes\tpath", ...records.map(({ index, bytes, path }) => `${index}\t${bytes}\t${path}`)].join("\n") + "\n",
);
writeFileSync(options.curlConfig, renderCurlConfig(records, options));

console.error(`Selected ${records.length.toLocaleString()} files (${report.selectedGiB.toFixed(2)} GiB)`);
console.error(`Wrote ${options.report}`);
console.error(`Wrote ${options.curlConfig}`);

function readGzipLines(path) {
  return gunzipSync(readFileSync(path)).toString("utf8").split(/\r?\n/).filter(Boolean);
}

function spacedIndices(length, count) {
  const indices = [];
  for (let position = 0; position < count; position += 1) {
    indices.push(Math.min(length - 1, Math.floor((position + 0.5) * length / count)));
  }
  return [...new Set(indices)];
}

async function concurrentMap(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const position = cursor;
      cursor += 1;
      if (position >= values.length) return;
      completed += 1;
      results[position] = await mapper(values[position], completed);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function contentLength(url, retries) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = Number(response.headers.get("content-length"));
      if (!Number.isFinite(value) || value <= 0) throw new Error("missing content-length");
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 250));
    }
  }
  throw new Error(`Unable to size ${url}: ${lastError}`);
}

function segmentFromPath(path) {
  const match = path.match(/\/segments\/([^/]+)\/wat\//);
  return match?.[1] ?? "unknown-segment";
}

function renderCurlConfig(records, options) {
  const globalOptions = [
    "parallel",
    `parallel-max = ${options.downloadConcurrency}`,
    "fail",
    "location",
    `retry = ${options.retries}`,
    "retry-all-errors",
    "retry-delay = 30",
    "retry-max-time = 3600",
    'continue-at = "-"',
    "connect-timeout = 30",
    "speed-time = 120",
    "speed-limit = 1024",
  ];
  const downloads = records.flatMap(({ url, output }) => [
    `url = "${escapeConfig(url)}"`,
    `output = "${escapeConfig(output.replaceAll("\\", "/"))}"`,
  ]);
  return [...globalOptions, ...downloads, ""].join("\n");
}

function escapeConfig(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  const root = resolve(values.get("--root") ?? "N:/mia/commoncrawl/CC-MAIN-2026-30");
  return {
    manifest: resolve(values.get("--manifest") ?? join(root, "wat.paths.gz")),
    outDir: resolve(values.get("--out-dir") ?? join(root, "wat")),
    report: resolve(values.get("--report") ?? join(root, "wat-selection.json")),
    tsv: resolve(values.get("--tsv") ?? join(root, "wat-selection.tsv")),
    curlConfig: resolve(values.get("--curl-config") ?? join(root, "wat-download.curl")),
    baseUrl: values.get("--base-url") ?? "https://data.commoncrawl.org",
    targetGiB: Number(values.get("--target-gib") ?? 200),
    candidates: Number(values.get("--candidates") ?? 2_000),
    concurrency: Number(values.get("--concurrency") ?? 48),
    downloadConcurrency: Number(values.get("--download-concurrency") ?? 4),
    retries: Number(values.get("--retries") ?? 10),
  };
}
