import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { V2_SYMBOL_CODE_LENGTHS } from "../src/generated/v2-codec-model";
import { ASCII_SYMBOL, EXT_DICT_SYMBOL, literalSymbol } from "../src/model";
import { heldoutBucket, type HeldoutRecord } from "./heldout-sampling";

type WeightedRecord = HeldoutRecord & { weight: number };
type Candidate = { value: string; rawCount: number; weightedCount: number; estimatedBitsSaved: number };
type Manifest = { weights: { datasets: Record<string, number>; contexts: Record<string, number> } };
type TokenizerModel = {
  heldoutFiles: string[];
  payloadTerms: string[];
  subwordTerms?: string[];
  subwordTraining?: unknown;
};

export type SubwordTrainingOptions = {
  vocabularySize: number;
  minimumLength: number;
  maximumLength: number;
  minimumRawCount: number;
  tokenBits: number;
  reservedTerms?: ReadonlySet<string>;
};

const root = resolve(import.meta.dirname, "..");
const reports = resolve(root, process.argv[2] ?? "data/training/full-2026-08-18/reports");
const vocabularySize = Number(process.env.SUBWORD_VOCABULARY_SIZE ?? 4096);

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  await train();
}

async function train(): Promise<void> {
  const tokenizerPath = join(reports, "tokenizer-model.json");
  const tokenizer = JSON.parse(await readFile(tokenizerPath, "utf8")) as TokenizerModel;
  const manifest = JSON.parse(await readFile(join(reports, "report-manifest.json"), "utf8")) as Manifest;
  const records: WeightedRecord[] = [];

  for (const file of tokenizer.heldoutFiles) {
    const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line) as HeldoutRecord;
      if (heldoutBucket(record) >= 70) continue;
      const context = `${record.linkClass}/${record.linkPresentation}`;
      const weight = (manifest.weights.datasets[record.dataset] ?? 1)
        * (manifest.weights.contexts[context] ?? 1);
      if (weight > 0) records.push({ ...record, weight });
    }
  }

  const markerBits = V2_SYMBOL_CODE_LENGTHS.ascii[EXT_DICT_SYMBOL];
  const result = trainUrlSubwords(records, {
    vocabularySize,
    minimumLength: 3,
    maximumLength: 16,
    minimumRawCount: 4,
    tokenBits: markerBits + 14,
    reservedTerms: new Set(tokenizer.payloadTerms),
  });
  tokenizer.subwordTerms = result.terms;
  tokenizer.subwordTraining = {
    algorithm: "weighted frequent substrings within URL path segments, query names/values, and fragments",
    split: "FNV-1a bucket 0-69",
    vocabularySize,
    maximumTokenBits: markerBits + 14,
    records: records.length,
    components: result.components,
    candidates: result.candidates,
    top: result.ranked.slice(0, 100),
  };
  await writeFile(tokenizerPath, `${JSON.stringify(tokenizer, null, 2)}\n`);
  console.log(`wrote ${tokenizerPath}`);
  console.log(`trained ${result.terms.length} URL subwords from ${records.length} records`);
}

export function trainUrlSubwords(
  records: readonly WeightedRecord[],
  options: SubwordTrainingOptions,
): { terms: string[]; components: number; candidates: number; ranked: Candidate[] } {
  const counts = new Map<string, { rawCount: number; weightedCount: number }>();
  let components = 0;
  for (const record of records) {
    let parsed: URL;
    try {
      parsed = new URL(record.url);
    } catch {
      continue;
    }
    for (const component of urlTextComponents(parsed)) {
      components += 1;
      for (const run of component.match(/[A-Za-z]{3,128}/g) ?? []) {
        for (let start = 0; start <= run.length - options.minimumLength; start += 1) {
          const maximum = Math.min(options.maximumLength, run.length - start);
          for (let length = options.minimumLength; length <= maximum; length += 1) {
            const value = run.slice(start, start + length);
            const count = counts.get(value) ?? { rawCount: 0, weightedCount: 0 };
            count.rawCount += 1;
            count.weightedCount += record.weight;
            counts.set(value, count);
          }
        }
      }
    }
  }

  const ranked = [...counts].flatMap(([value, count]): Candidate[] => {
    if (count.rawCount < options.minimumRawCount || options.reservedTerms?.has(value)) return [];
    const bitsSavedPerUse = literalBits(value) - options.tokenBits;
    if (bitsSavedPerUse <= 0) return [];
    return [{
      value,
      rawCount: count.rawCount,
      weightedCount: count.weightedCount,
      estimatedBitsSaved: bitsSavedPerUse * count.weightedCount,
    }];
  }).sort((left, right) =>
    right.estimatedBitsSaved - left.estimatedBitsSaved
    || right.value.length - left.value.length
    || left.value.localeCompare(right.value)
  );

  return {
    terms: ranked.slice(0, options.vocabularySize).map(({ value }) => value),
    components,
    candidates: ranked.length,
    ranked,
  };
}

function urlTextComponents(url: URL): string[] {
  const components = url.pathname.split("/").filter(Boolean);
  for (const field of url.search.slice(1).split("&")) {
    if (!field) continue;
    const equals = field.indexOf("=");
    if (equals === -1) components.push(field);
    else components.push(field.slice(0, equals), field.slice(equals + 1));
  }
  if (url.hash.length > 1) components.push(...url.hash.slice(1).split(/[/?&=]/).filter(Boolean));
  return components;
}

function literalBits(value: string): number {
  const lengths = V2_SYMBOL_CODE_LENGTHS.ascii;
  return [...value].reduce((bits, character) => {
    const symbol = literalSymbol(character);
    return bits + (symbol === undefined ? lengths[ASCII_SYMBOL] + 7 : lengths[symbol]);
  }, 0);
}
