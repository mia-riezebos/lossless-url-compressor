import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ASCII_CLIENT_ALPHABET,
  ASCII_SERVER_ALPHABET,
  CJK_ALPHABET,
  CJK_CLIENT_ALPHABET,
} from "../src/alphabet";
import { encodeUrl } from "../src/codec";
import { V2_LITERAL_PRIORITY, V2_PRIMARY_DICTIONARY, type V2HeaderModeId } from "../src/generated/v2-codec-model";
import {
  ASCII_SYMBOL,
  END_SYMBOL,
  EXT_DICT_SYMBOL,
  LITERAL_ALPHABET,
  NUMBER_SYMBOL,
  REF_SYMBOL,
  SYMBOL_COUNT,
  V2_PRIMARY_DICTIONARY_OFFSET,
  V2_ROUTE_SYMBOL,
  literalSymbol,
} from "../src/model";
import { normalizeForCompression } from "../src/normalize";
import { encodeV2Payload } from "../src/v2-codec";
import { heldoutBucket, sampleHeldoutFiles } from "./heldout-sampling";

type Mode = { name: V2HeaderModeId; allowFragment: boolean; useCjkPayload: boolean; alphabet: string };
type Totals = {
  rows: number;
  weight: number;
  v1Chars: number;
  v2Chars: number;
  v1PayloadChars: number;
  v2PayloadChars: number;
  untrainedV2Chars: number;
  tieredV2Chars: number;
  wins: number;
  ties: number;
  losses: number;
};

const modes: Mode[] = [
  { name: "ascii", allowFragment: false, useCjkPayload: false, alphabet: ASCII_SERVER_ALPHABET },
  { name: "ascii-fragment", allowFragment: true, useCjkPayload: false, alphabet: ASCII_CLIENT_ALPHABET },
  { name: "cjk", allowFragment: false, useCjkPayload: true, alphabet: CJK_ALPHABET },
  { name: "cjk-fragment", allowFragment: true, useCjkPayload: true, alphabet: CJK_CLIENT_ALPHABET },
];
const reports = resolve(process.argv[2] ?? "data/training/full-2026-08-18/reports");
const samplePerFile = Number(process.env.SAMPLE_PER_FILE ?? 500);
const model = JSON.parse(await readFile(join(reports, "tokenizer-model.json"), "utf8")) as {
  heldoutFiles: string[];
};
const manifest = JSON.parse(await readFile(join(reports, "report-manifest.json"), "utf8")) as {
  weights: { datasets: Record<string, number>; contexts: Record<string, number> };
};
const samples = await sampleHeldoutFiles(model.heldoutFiles, samplePerFile, (record) => heldoutBucket(record) >= 85);
const totals = Object.fromEntries(modes.map((mode) => [mode.name, emptyTotals()])) as Record<string, Totals>;
const tieredCodeLengths = previousTieredCodeLengths();
let rejected = 0;

for (const record of samples) {
  const context = `${record.linkClass}/${record.linkPresentation}`;
  const weight = (manifest.weights.datasets[record.dataset] ?? 1) * (manifest.weights.contexts[context] ?? 1);
  if (weight <= 0) continue;
  try {
    for (const mode of modes) {
      const options = {
        allowFragment: mode.allowFragment,
        origin: "http://piss.zip",
        useCjkPayload: mode.useCjkPayload,
      };
      const v1 = encodeUrl(record.url, { ...options, version: "1" });
      const v2 = encodeUrl(record.url, { ...options, version: "2" });
      const tieredPayload = encodeV2Payload(
        normalizeForCompression(record.url),
        mode.alphabet,
        mode.name,
        {},
        tieredCodeLengths,
      );
      const tieredLength = "http://piss.zip".length + 1 + [...tieredPayload.payload].length;
      const untrained = encodeUrl(record.url, {
        ...options,
        version: "2",
        tokenizer: { useDictionary: false, useRoutes: false, useShareDictionary: false },
      });
      const total = totals[mode.name];
      total.rows += 1;
      total.weight += weight;
      total.v1Chars += v1.stats.shortUrlLength * weight;
      total.v2Chars += v2.stats.shortUrlLength * weight;
      total.v1PayloadChars += payloadCharacters(v1.payload) * weight;
      total.v2PayloadChars += payloadCharacters(v2.payload) * weight;
      total.untrainedV2Chars += untrained.stats.shortUrlLength * weight;
      total.tieredV2Chars += tieredLength * weight;
      if (v2.stats.shortUrlLength < v1.stats.shortUrlLength) total.wins += 1;
      else if (v2.stats.shortUrlLength === v1.stats.shortUrlLength) total.ties += 1;
      else total.losses += 1;
    }
  } catch {
    rejected += 1;
  }
}

const results = modes.map(({ name }) => {
  const total = totals[name];
  const v1Average = total.v1Chars / total.weight;
  const v2Average = total.v2Chars / total.weight;
  return {
    mode: name,
    rows: total.rows,
    weightedAverageShortUrl: {
      v1: v1Average,
      v2: v2Average,
      v2WithoutLearnedTokenizer: total.untrainedV2Chars / total.weight,
      v2PreviousTieredSymbols: total.tieredV2Chars / total.weight,
    },
    weightedAveragePayload: {
      v1: total.v1PayloadChars / total.weight,
      v2: total.v2PayloadChars / total.weight,
    },
    payloadImprovementCharacters: (total.v1PayloadChars - total.v2PayloadChars) / total.weight,
    payloadImprovementPercent: ((total.v1PayloadChars - total.v2PayloadChars) / total.v1PayloadChars) * 100,
    improvementCharacters: v1Average - v2Average,
    improvementPercent: ((v1Average - v2Average) / v1Average) * 100,
    unweightedComparison: { wins: total.wins, ties: total.ties, losses: total.losses },
  };
});
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  methodology: `FNV-1a evaluation buckets 85-99, with up to ${samplePerFile} URLs per corpus; report dataset and context weights applied. Buckets 0-69 train structured suffixes and Huffman lengths, and 70-84 are reserved for validation. Aggregate cubes predate this split and contain corpus-wide counts, so this is token-level isolation rather than a fully corpus-isolated benchmark.`,
  sampledRows: samples.length,
  rejectedRows: rejected,
  results,
};
await writeFile(join(reports, "tokenizer-benchmark.json"), `${JSON.stringify(output, null, 2)}\n`);
await writeFile(join(reports, "tokenizer-benchmark.md"), renderMarkdown(output));
console.log(JSON.stringify(output, null, 2));

function emptyTotals(): Totals {
  return { rows: 0, weight: 0, v1Chars: 0, v2Chars: 0, v1PayloadChars: 0, v2PayloadChars: 0, untrainedV2Chars: 0, tieredV2Chars: 0, wins: 0, ties: 0, losses: 0 };
}

function payloadCharacters(payload: string): number {
  return [...(payload.startsWith("#") ? payload.slice(1) : payload)].length;
}

function previousTieredCodeLengths(): number[] {
  const literals = V2_LITERAL_PRIORITY.map(literalSymbol).filter((symbol): symbol is number => symbol !== undefined);
  const primary = Array.from({ length: V2_PRIMARY_DICTIONARY.length }, (_, index) => V2_PRIMARY_DICTIONARY_OFFSET + index);
  const preferred = [V2_ROUTE_SYMBOL, END_SYMBOL, EXT_DICT_SYMBOL, NUMBER_SYMBOL, ASCII_SYMBOL, REF_SYMBOL, ...literals, ...primary];
  const unique = [...new Set(preferred)];
  const order = [...unique, ...Array.from({ length: SYMBOL_COUNT }, (_, symbol) => symbol).filter((symbol) => !unique.includes(symbol))];
  const lengths = Array.from({ length: SYMBOL_COUNT }, () => 7);
  order.forEach((symbol, rank) => lengths[symbol] = rank < 16 ? 5 : rank < 32 ? 6 : 7);
  if (LITERAL_ALPHABET.length + 1 !== V2_PRIMARY_DICTIONARY_OFFSET) throw new Error("Unexpected v2 symbol layout");
  return lengths;
}

function renderMarkdown(output: typeof output): string {
  const rows = output.results.map((result) =>
    `| ${result.mode} | ${result.rows.toLocaleString()} | ${result.weightedAverageShortUrl.v1.toFixed(3)} | ${result.weightedAverageShortUrl.v2PreviousTieredSymbols.toFixed(3)} | ${result.weightedAverageShortUrl.v2.toFixed(3)} | ${(result.weightedAverageShortUrl.v2PreviousTieredSymbols - result.weightedAverageShortUrl.v2).toFixed(3)} | ${result.improvementPercent.toFixed(2)}% | ${result.unweightedComparison.wins}/${result.unweightedComparison.ties}/${result.unweightedComparison.losses} |`,
  );
  return `# Held-out v2 tokenizer benchmark\n\n${output.methodology}\n\n| Mode | URLs | v1 chars | tiered v2 chars | Huffman v2 chars | Huffman gain | v2 vs v1 | W/T/L |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n`;
}
