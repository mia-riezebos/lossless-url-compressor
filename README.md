# Lossless URL Compressor

WIP spec plus TypeScript proof of concept for a stateless, deterministic, lossless URL compressor for `http://piss.zip/`.

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

The UI view counter is an all-time Durable Object counter. It snapshots to D1 every few hours for backup/history. An optional Cloudflare Analytics token can seed the counter on first boot from recent analytics:

```sh
pnpm dlx wrangler secret put PISSZIP_ANALYTICS_TOKEN
pnpm dlx wrangler d1 execute pisszip_analytics --remote --file migrations/d1/0001_view_counter.sql
```

Use `PISSZIP_ANALYTICS_TOKEN` in `.env` for local `pnpm dev` analytics fallback. Avoid `CF_API_TOKEN` for this value because Wrangler treats that name as its own deployment auth token.

## Spec

Start with [`SPEC.md`](./SPEC.md).

## MVP implementation

- TypeScript codec in `src/codec.ts`.
- Manual scheme/host normalization in `src/normalize.ts`; no `URL` parser.
- Unicode input URLs are supported; payloads are ASCII-safe by default with optional CJK Unicode output for fewer visible chars.
- v2 server links use `http://piss.zip/<payload>`; fragment/client-max links use `http://piss.zip#<payload>` and therefore avoid a redundant root slash.
- Hono Worker in `src/worker.ts` redirects only canonical server-visible payloads to the decoded URL; valid non-canonical payloads serve the UI for local inspection instead of redirecting.
- v2 uses a trained, self-delimiting 1/2/3-character host header followed by an independently radix-packed body. The body starts with unary wire version `0`; future incompatible bodies use `10`, `110`, and so on without consuming a dedicated visible version character.
- Deployed `/1/<payload>` links are the single route-level compatibility exception and continue to use the original v1 alphabet and decoder unchanged.
- Trained compression pipeline:
  - `normalize.ts`: scheme/host normalization + HTTPS omission
  - `tokenize.ts`: minimum-bit parse into literals, trained URL segments/subwords, curated sharing-site routes, numeric runs, and LZ refs
  - `generated/v2-codec-model.ts`: frozen four-mode host/suffix tables and trained v2 payload terms
  - `v2-codec.ts`: variable-length header selection, structural fields, body framing, and reconstruction
  - `model.ts`: v1 dictionaries plus the separately gated v2 payload-term tail
  - `coder-v1.ts`: shared token grammar with distinct v1 scheme framing and v2 body-only framing
  - `wire-version.ts`: prefix-free unary v2 wire framing
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

For v2 corpus work, add `--raw-stats data/.../training-cube.jsonl.gz` to the Rust scan, then run `pnpm train:reports -- --cubes <comma-separated cubes> --out-dir data/training/reports`. The package command invokes the Rust trainer's streaming `report` mode. It emits reweightable machine-readable results plus header shortlists for all four ASCII/CJK and server/fragment modes, common-symbol analysis, and cross-dataset comparisons. See `tools/urltrainer/README.md` for the schema and weighting options.

After choosing weights, freeze a stripped runtime model from the reports with `pnpm train:codec:model`. The generated artifact records a SHA-256 content hash and removes analytical counts/context breakdowns; reordering any entry is a wire-format change.

Detailed v2 design documents:

- [v2 training and model selection](docs/v2-training.md)
- [v2 variable-length header format](docs/v2-header-format.md)
