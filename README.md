# Lossless URL Compressor

WIP spec plus TypeScript proof of concept for a stateless, deterministic, lossless URL compressor for `https://piss.zip/`.

## Run

```sh
pnpm install
pnpm dev
pnpm test
pnpm build
pnpm worker:dev
```

Open the Vite dev URL for UI iteration, or `worker:dev` to test the Hono/Workers redirect path.
Deploy with:

```sh
pnpm deploy
```

## Spec

Start with [`SPEC.md`](./SPEC.md).

## MVP implementation

- TypeScript codec in `src/codec.ts`.
- Manual scheme/host normalization in `src/normalize.ts`; no `URL` parser.
- Unicode input URLs are supported; payloads are ASCII-safe by default with optional CJK Unicode output for fewer visible chars.
- Optional leading `#` payload when fragment/client-max mode is enabled.
- Hono Worker in `src/worker.ts` redirects server-visible payloads directly to the decoded URL.
- `/1/`, `/2/`, and `/3/` are headerless radix formats with different static prefix-code tables for token symbols. The UI can auto-pick the shortest; `/0/` payloads still decode for compatibility.
- Trained compression pipeline:
  - `normalize.ts`: scheme/host normalization + HTTPS omission
  - `tokenize.ts`: optimal parse into literals, trained dictionary phrases, numeric runs, and LZ refs
  - `model.ts`: generated literal alphabet + dictionaries from Wikipedia externallinks analysis
  - `coder.ts`: token stream to bits
  - `radix.ts`: bits to URL-observable alphabet
  - `codec.ts`: glue

## Training

Fast Rust analyzer, recommended while iterating. It now splits sampled URLs into training and held-out sets, filters over-specific candidates, and emits a marginal-gain dictionary selection before the raw frequency table:

```sh
cd tools/urltrainer
cargo build --release
cd ../..

./tools/urltrainer/target/release/urltrainer data/wiki/simplewiki-latest-externallinks.sql \
  --out data/wiki/simplewiki-rust-analysis.md --threads 8 --top 160 \
  --read-order interleaved --heldout-urls 20000 --candidate-pool 512 \
  --token-budget 128 --report-every-secs 10
```

Common Crawl CDXJ shards should be analyzed compressed, not decompressed:

```sh
./tools/urltrainer/target/release/urltrainer data/commoncrawl/CC-MAIN-2026-21/shards \
  --format common-crawl-cdxj \
  --out data/commoncrawl/CC-MAIN-2026-21/commoncrawl-rust-analysis.md \
  --threads 8 --sample-every 100 --top 160 --heldout-urls 20000 \
  --candidate-pool 512 --token-budget 128 --report-every-secs 30
```

Python model generator consumes `Selected dictionary entries` when present, falling back to the raw candidate table for older reports:

```sh
python3 scripts/write-trained-model.py data/wiki/simplewiki-rust-analysis.md --out src/model.ts
```

Older Python analyzer/trainer scripts are kept for comparison, but the Rust tool is the iteration path.
