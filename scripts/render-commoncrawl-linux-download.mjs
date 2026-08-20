import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const [reportArgument, outputArgument] = process.argv.slice(2);
if (!reportArgument || !outputArgument) {
  throw new Error("Usage: node scripts/render-commoncrawl-linux-download.mjs <selection.json> <output.curl>");
}

const reportPath = resolve(reportArgument);
const outputPath = resolve(outputArgument);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const windowsRoot = resolve(dirname(reportPath), "wat");
const linuxRoot = "/mnt/media/mia/commoncrawl/CC-MAIN-2026-30/wat";

const lines = [
  "parallel",
  "parallel-max = 4",
  "fail",
  "location",
  "create-dirs",
  "retry = 20",
  "retry-all-errors",
  "retry-delay = 30",
  "retry-max-time = 3600",
  'continue-at = "-"',
  "connect-timeout = 30",
  "speed-time = 120",
  "speed-limit = 1024",
];

for (const record of report.records) {
  const relativeOutput = relative(windowsRoot, resolve(record.output)).replaceAll("\\", "/");
  lines.push(`url = "${escapeConfig(record.url)}"`);
  lines.push(`output = "${escapeConfig(`${linuxRoot}/${relativeOutput}`)}"`);
}

writeFileSync(outputPath, `${lines.join("\n")}\n`);
console.error(`Wrote ${outputPath} for ${report.records.length.toLocaleString()} files`);

function escapeConfig(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
