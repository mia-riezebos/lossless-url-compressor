import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ASCII_CLIENT_ALPHABET,
  ASCII_SERVER_ALPHABET,
  CJK_ALPHABET,
  CJK_CLIENT_ALPHABET,
} from "../src/alphabet";
import { trainLengthLimitedHuffman } from "../src/canonical-huffman";
import { V2_SYMBOL_CODE_LENGTHS, type V2HeaderModeId } from "../src/generated/v2-codec-model";
import { SYMBOL_COUNT } from "../src/model";
import { normalizeForCompression } from "../src/normalize";
import { encodeV2Payload } from "../src/v2-codec";
import { heldoutBucket, sampleHeldoutFiles } from "./heldout-sampling";

type TokenizerModel = {
  heldoutFiles: string[];
  symbolCodeLengths?: Partial<Record<V2HeaderModeId, number[]>>;
  huffmanTraining?: unknown;
};
type Manifest = { weights: { datasets: Record<string, number>; contexts: Record<string, number> } };
const modeAlphabets: Record<V2HeaderModeId, string> = {
  ascii: ASCII_SERVER_ALPHABET,
  "ascii-fragment": ASCII_CLIENT_ALPHABET,
  cjk: CJK_ALPHABET,
  "cjk-fragment": CJK_CLIENT_ALPHABET,
};
const modes = Object.keys(modeAlphabets) as V2HeaderModeId[];
const reports = resolve(process.argv[2] ?? "data/training/full-2026-08-18/reports");
const samplePerFile = Number(process.env.SAMPLE_PER_FILE ?? 500);
const maximumBits = Number(process.env.HUFFMAN_MAX_BITS ?? 10);
const maximumIterations = Number(process.env.HUFFMAN_ITERATIONS ?? 6);
const tokenizerPath = join(reports, "tokenizer-model.json");
const tokenizer = JSON.parse(await readFile(tokenizerPath, "utf8")) as TokenizerModel;
const manifest = JSON.parse(await readFile(join(reports, "report-manifest.json"), "utf8")) as Manifest;
const records = await sampleHeldoutFiles(tokenizer.heldoutFiles, samplePerFile, (record) => heldoutBucket(record) < 70);
const lengths = Object.fromEntries(modes.map((mode) => [
  mode,
  [...(tokenizer.symbolCodeLengths?.[mode] ?? V2_SYMBOL_CODE_LENGTHS[mode])],
])) as Record<V2HeaderModeId, number[]>;
const iterations: Array<{ iteration: number; changedModes: V2HeaderModeId[] }> = [];

for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
  const frequencies = Object.fromEntries(modes.map((mode) => [
    mode,
    Array.from({ length: SYMBOL_COUNT }, () => 0),
  ])) as Record<V2HeaderModeId, number[]>;
  for (const record of records) {
    const context = `${record.linkClass}/${record.linkPresentation}`;
    const weight = (manifest.weights.datasets[record.dataset] ?? 1) * (manifest.weights.contexts[context] ?? 1);
    if (weight <= 0) continue;
    let normalized;
    try {
      normalized = normalizeForCompression(record.url);
    } catch {
      continue;
    }
    for (const mode of modes) {
      try {
        const encoded = encodeV2Payload(normalized, modeAlphabets[mode], mode, {}, lengths[mode]);
        for (const symbol of encoded.symbols) frequencies[mode][symbol] += weight;
      } catch {
        // Oversized or otherwise unsupported held-out URLs are not useful code-length evidence.
      }
    }
  }
  const changedModes: V2HeaderModeId[] = [];
  for (const mode of modes) {
    const next = trainLengthLimitedHuffman(frequencies[mode], maximumBits);
    if (next.some((length, symbol) => length !== lengths[mode][symbol])) changedModes.push(mode);
    lengths[mode] = next;
  }
  iterations.push({ iteration, changedModes });
  console.log(`iteration ${iteration}: ${changedModes.length ? changedModes.join(", ") : "stable"}`);
  if (!changedModes.length) break;
}

tokenizer.symbolCodeLengths = lengths;
tokenizer.huffmanTraining = {
  algorithm: "canonical length-limited Huffman with iterative exact-cost retokenization",
  calibrationSplit: "FNV-1a bucket 0-69",
  samplePerFile,
  sampledRows: records.length,
  maximumBits,
  iterations,
};
await writeFile(tokenizerPath, `${JSON.stringify(tokenizer, null, 2)}\n`);
console.log(`wrote ${tokenizerPath}`);
