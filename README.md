# Lossless URL Compressor

WIP spec plus TypeScript proof of concept for a stateless, deterministic, lossless URL compressor for `https://l.mia.cx/`.

## Run

```sh
pnpm install
pnpm dev
pnpm test
pnpm build
```

Open the Vite dev URL and use the raw HTML input/settings/output UI.

## Spec

Start with [`SPEC.md`](./SPEC.md).

## MVP implementation

- TypeScript codec in `src/codec.ts`.
- Manual scheme/host normalization in `src/normalize.ts`; no `URL` parser.
- ASCII-safe payloads only; no raw `%`, no non-ASCII output.
- Optional leading `#` payload when fragment/client-max mode is enabled.
- Trained compression pipeline:
  - `normalize.ts`: scheme/host normalization + HTTPS omission
  - `tokenize.ts`: optimal parse into literals, trained dictionary phrases, numeric runs, and LZ refs
  - `model.ts`: generated literal alphabet + dictionaries from Wikipedia externallinks analysis
  - `coder.ts`: token stream to bits
  - `radix.ts`: bits to URL-observable alphabet
  - `codec.ts`: glue

## Training

Fast Rust analyzer, recommended while iterating:

```sh
cd tools/urltrainer
cargo build --release
cd ../..

./tools/urltrainer/target/release/urltrainer data/wiki/simplewiki-latest-externallinks.sql \
  --out data/wiki/simplewiki-rust-analysis.md --threads 8 --top 160 \
  --read-order interleaved --report-every-secs 10
```

Python model generator still consumes the Markdown analysis format:

```sh
python3 scripts/write-trained-model.py data/wiki/simplewiki-rust-analysis.md --out src/model.ts
```

Older Python analyzer/trainer scripts are kept for comparison, but the Rust tool is the iteration path.
