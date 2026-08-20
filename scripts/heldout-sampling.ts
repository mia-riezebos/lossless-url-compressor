import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

export type HeldoutRecord = {
  url: string;
  dataset: string;
  linkClass: string;
  linkPresentation: string;
};

export function heldoutBucket(record: HeldoutRecord): number {
  return fnv1a(`${record.dataset}\0${record.url}`) % 100;
}

export async function sampleHeldoutFiles(
  files: readonly string[],
  perFile: number,
  accept: (record: HeldoutRecord) => boolean,
): Promise<HeldoutRecord[]> {
  return (await Promise.all(files.map((file) => sampleFile(file, perFile, accept)))).flat();
}

async function sampleFile(
  file: string,
  limit: number,
  accept: (record: HeldoutRecord) => boolean,
): Promise<HeldoutRecord[]> {
  const selected: Array<{ hash: number; record: HeldoutRecord }> = [];
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line) as HeldoutRecord;
    if (!accept(record)) continue;
    const hash = fnv1a(`${record.url}\0sample`);
    if (selected.length < limit) {
      selected.push({ hash, record });
      if (selected.length === limit) selected.sort((left, right) => right.hash - left.hash);
    } else if (hash < selected[0].hash) {
      selected[0] = { hash, record };
      selected.sort((left, right) => right.hash - left.hash);
    }
  }
  return selected.map(({ record }) => record);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
