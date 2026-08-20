# URL trainer

The trainer streams supported corpora into the existing dictionary analysis. Archives are read directly and are never extracted or rewritten on disk.

## Messaging archives

Point the trainer at the directory containing the downloaded messaging datasets:

```powershell
cargo run --release --manifest-path tools/urltrainer/Cargo.toml -- `
  N:\mia\commoncrawl\messaging-links\corpora `
  --format messaging-archives `
  --collection public-messaging-links-2026-08 `
  --public-suffix-list data/publicsuffix/public_suffix_list.dat `
  --out data/messaging/urltrainer.md `
  --raw-stats data/messaging/training-cube.jsonl.gz `
  --header-stats data/messaging/header-corpus-stats.json `
  --header-heldout data/messaging/header-heldout.jsonl.gz `
  --threads 8
```

The messaging sanitizer runs inside the trainer. It streams Discord Unveiled (`.zst` tar), TGDataset (`.tar.gz`), DISCO (`.zip` XML), Telegram Group-verse (`.zip` JSON), and the WhatsApp public-groups TSV without producing cleaned sibling datasets. It emits URL records only; message bodies, usernames, channel IDs, and attachment metadata are not retained.

For full messaging runs, use the shard coordinator instead of pointing one trainer process at the whole corpus directory:

```powershell
pnpm train:messaging:shards -- `
  --input N:\mia\commoncrawl\messaging-links\corpora `
  --output data\training\messaging-shards `
  --trainer tools\urltrainer\target\release\urltrainer.exe `
  --public-suffix-list data\publicsuffix\public_suffix_list.dat `
  --collection public-messaging-links-2026-08 `
  --jobs 2 `
  --threads-per-shard 2
```

Each supported archive is an independent immutable shard with its own aggregate cube, held-out URL sample, header artifacts, logs, and atomic `complete.json`. `manifest.json` is rewritten as shards change state. Re-running the same command verifies the input, trainer, public-suffix list, and options fingerprint; completed shards are skipped and incomplete or changed shards are retried. Failures are recorded per shard and do not prevent other inputs from finishing.

Two concurrent archives is the conservative default because each trainer maintains large bounded counters. Increase `--jobs` only when RAM and the underlying disks can sustain multiple independent aggregate processes. Individual gzip/zstd streams remain sequential, but independent archive shards decompress concurrently.

Corpus failures are isolated at the narrowest safely resumable scope. A malformed JSONL/TSV record is counted and skipped, a malformed monolithic JSON/XML archive member is abandoned after retaining any records already emitted from its valid prefix, and an unreadable archive is skipped while later inputs continue. Each failure is logged with dataset, input, member, scope, stage, and a bounded error description; message contents are never logged. The summary reports failed input/member/record counts, with detailed failures capped to keep hostile corpora from consuming unbounded memory. Only output-sink and control failures remain fatal because continuing could not produce a trustworthy artifact.

Bot-authored Discord messages are skipped by default. Direct messages use the `message` training class and forwarded Telegram messages use `forwarded-message`, while the source platform is retained as `discord.com`, `telegram.org`, or `whatsapp.com`. Known redirect shims are unwrapped without network requests.

Established opaque shortener hosts (`t.co`, `t.me`, `bit.ly`, TinyURL, and the same default list used by the header optimizer) are always removed. The default `--messaging-media-filter expanded` also removes URLs on Tenor, Giphy, Gfycat, Redgifs, Gifer, Gifbin, Reaction GIFs, MakeAGif, Imgur, Lightshot/prnt.sc, Gyazo, ImgBB/ibb.co, Postimage, ImageBam, ImageVenue, and Discord's media CDN. Matching includes subdomains. Use `--messaging-media-filter gif` to remove only GIF providers, `--messaging-media-filter none` to disable the built-in media list, or `--messaging-exclude-hosts "example.test,media.example"` to extend it.

For bounded format probes, `--messaging-message-limit 10000` stops after that many messages. Omit it for the complete streaming run. Add `--messaging-include-bots` only when bot-posted links are intentionally part of the desired distribution.

## Reweightable output and reports

`--raw-stats` writes a versioned, gzip-compressed JSONL aggregate cube. It is not a URL or message dump. Every count is keyed by an independent dataset and context/presentation signal, including hosts, public suffixes, source sites, characters, path segments, query keys, and dictionary terms. Host/suffix observations feed the header search only; body dictionary terms come from paths and query strings, preventing double-counting a header-resolved host position such as `.com/`. The held-out JSONL records carry the same dataset identity. This is the durable output of the expensive scan. Do not combine `--header-only` with a scan intended for the common-symbol report: that optimization intentionally skips character and term collection.

Generate human and machine-readable reports from any number of cubes without rereading the corpora. The Rust `report` mode performs a sorted streaming merge of the gzip cubes, retains bounded top-K report candidates, and spools the host-total join to disk instead of retaining the complete term and host-pattern tail in memory:

```powershell
pnpm train:reports -- `
  --cubes "data/commoncrawl/CC-MAIN-2026-30/training-cube.jsonl.gz,data/messaging/training-cube.jsonl.gz" `
  --out-dir data/training/reports `
  --family-weights "commoncrawl=1,discord=4,telegram=5,whatsapp=6" `
  --dataset-weights "disco=0.75,telegram-groupverse=1.25" `
  --context-weights "social-post/visible-url=32,message/visible-url=40,forwarded-message/visible-url=16"
```

The command produces:

- `report-manifest.json`: cube inputs, dimensions, and the exact configured weights.
- `header-shortlists.json` and `.md`: independent allocation searches for ASCII, ASCII+fragment, CJK, and CJK+fragment modes. Each compares one-character-only, up-to-two-character, and up-to-three-character headers, reports the 1/2/3 lead split curve, and exposes whether a third CJK character adds any coverage or savings.
- `hosts.jsonl`: every observed host, sorted lexicographically, with one aggregate `rawCount` and post-hoc `weightedCount`; dataset/context dimensions are intentionally omitted for compact inspection.
- `common-symbols.json` and `.md`: reweightable literal-character and dictionary-term candidates with per-dataset and per-context contributions.
- `host-patterns.json` and `.md`: host-conditioned path/query structures, their within-host coverage, 95% Wilson lower bound, reusable-tail savings, and contiguous combined-token alternatives such as `youtube.com/watch?v=`. The JSON contains global rankings plus per-host rankings; Markdown shows the first 100 high-volume hosts. Low-frequency observations remain in the raw cube.
- `source-comparison.json` and `.md`: Discord, Telegram, WhatsApp, Common Crawl, and individual-dataset totals and top hosts/suffixes/terms.

The Rust report pass deliberately stops at reweightable evidence. Freeze and benchmark the header-aware payload model from the repository root:

```powershell
pnpm train:tokenizer
pnpm train:tokenizer:benchmark
```

The tokenizer command also iterates exact-cost retokenization and per-mode canonical Huffman training until stable. This adds `tokenizer-model.json`, `tokenizer-benchmark.json`, and `tokenizer-benchmark.md` to the report directory and regenerates the compact TypeScript model consumed by both encoder and decoder. Calibration uses deterministic held-out buckets 0–69 and evaluation reads buckets 85–99. Aggregate cube counts still span the complete input corpus, so use time- or shard-separated corpora for a fully isolated final benchmark.

Family weights multiply dataset weights, so a broad Discord/Telegram/Common-Crawl adjustment and a specific dataset correction can coexist. Markdown tables are intentionally capped. The JSON reports contain the complete evaluated shortlists, while the raw cube retains every aggregate counter that survived the trainer's documented counter limit. Change any weight option and rerun only `train:reports`; Node is not involved in aggregation or report generation.

## Common Crawl WAT

Run from the repository root:

```powershell
cargo run --release --manifest-path tools/urltrainer/Cargo.toml -- `
  N:\mia\commoncrawl\CC-MAIN-2026-30\wat `
  --format common-crawl-wat `
  --collection CC-MAIN-2026-30 `
  --public-suffix-list data/publicsuffix/public_suffix_list.dat `
  --out data/commoncrawl/CC-MAIN-2026-30/urltrainer.md `
  --header-stats data/commoncrawl/CC-MAIN-2026-30/header-corpus-stats.json `
  --header-heldout data/commoncrawl/CC-MAIN-2026-30/header-heldout.jsonl.gz `
  --header-only `
  --threads 8
```

WAT links are deduplicated per source page, limited to three links per target registrable domain per page, and classified by source context as:

- `internal`
- `directory-external`
- `social-post`
- `social-profile`
- `forum-post`
- `forum`
- `video`
- `blog-news`
- `web`

Each link is also classified by presentation:

- `visible-url` when normalized display text matches the target URL
- `redirected-url` when a visible destination is recovered from a known redirect shim or Twitter/X display URL
- `submitted-url` when platform structure identifies a user-submitted destination even though the rendered link is a titled card
- `masked` when non-URL display text hides the target
- `missing-text`

Known query-parameter redirect shims are canonicalized without making network requests. This includes YouTube, Facebook/Messenger/Instagram, Google, LinkedIn, Reddit outbound links, Steam, Discord, Slack, Medium, and Tumblr's `href.li`. Opaque shorteners such as `t.co` can only be recovered when the page or a platform API exposes the destination. Reddit post permalinks identify their submitted link conservatively by matching the external anchor text to the WAT document title; unrelated masked comment and footer links remain zero-weight.

Masked and textless links default to zero training weight, but their raw counts are retained. The held-out records preserve the source URL, source hostname, source registrable domain, display text, original href, target URL, source context, and presentation class. Aggregate artifacts include target-host, suffix, source-site, and token-candidate counts across every combined context/presentation class. Token candidates cover host fragments, individual and multi-segment path phrases such as `/status/`, file endings, and query-key forms. This lets future optimizers weight Reddit differently from Facebook, revise presentation weights, or retrain the shared token dictionary without rereading WAT.

The header optimizer excludes established shortener/redirect hosts such as `t.co`, `t.me`, and `bit.ly` from host-symbol allocation by default. The original counts remain in the corpus. Add more exclusions without rescanning with `--exclude-hosts "example-shortener.test,another.test"`.

Optimizer reports rank allocations by a transparent score rather than raw frequency: projected encoded characters saved multiplied by the configured source-context/presentation weights. They include the weight table, top exact source sites ("links found on"), dominant signals and held-out source sites for every selected entry, and complete one-, two-, and three-character shortlists. Country-code public suffixes receive a mild `0.85` score multiplier by default because they are localized and already short; tune or disable it with `--cc-tld-weight 0.9` or `--cc-tld-weight 1` without rescanning WAT.

## Retune weights

```powershell
pnpm train:headers:optimize -- `
  --stats data/commoncrawl/CC-MAIN-2026-30/header-corpus-stats.json `
  --heldout data/commoncrawl/CC-MAIN-2026-30/header-heldout.jsonl.gz `
  --weights "social-post/visible-url=40,web/visible-url=4,web/masked=0" `
  --source-weights "reddit.com=2,facebook.com=0.25"
```

Changing `--weights` reruns only the compact header optimizer. It does not reread the WAT shards.
