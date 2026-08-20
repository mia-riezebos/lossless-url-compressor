# Training cube schema

The Rust trainer's `--raw-stats` output is the stable seam between expensive corpus scans and cheap report/scoring passes. It is gzip-compressed JSONL when the filename ends in `.gz`; decompression is optional and does not change the schema.

The first line is metadata:

```json
{"type":"metadata","schemaVersion":1,"datasets":["commoncrawl","discord-unveiled"],"datasetFamilies":["commoncrawl","discord"],"contexts":["internal/visible-url"],"signalIndex":"datasetIndex * contexts.length + contextIndex"}
```

Every following aggregate row contains sparse `[signalIndex, rawCount]` pairs:

```json
{"type":"host","key":"youtube.com","counts":[[110,42],[495,8]]}
```

Supported row types are `totals`, `scheme`, `tld`, `suffix`, `host`, `source`, `path-segment`, `query-key`, `term`, `host-pattern`, `character`, and `length`. Counts are raw and unweighted. Dataset, family, and context weights are applied only by the Rust trainer's streaming `report` mode.

`host-pattern` is the host-conditioned joint signal used for ubiquitous route structure. It carries explicit fields instead of overloading `key`:

```json
{"type":"host-pattern","host":"youtube.com","patternKind":"prefix-query","term":"/watch?v=","counts":[[110,42]]}
```

Pattern kinds distinguish one- through three-segment path prefixes/sequences, individual path segments, first and later query keys, query keys independent of position, path/query prefixes, and path/query suffix boundaries. Each pattern is counted at most once per URL. This permits post-hoc comparison of a combined `youtube.com/watch?v=` token with a `youtube.com` header symbol followed by `/watch?v=`, while `/status/` remains a reusable global term whose strong association with `x.com` is still measurable. The separate host rows provide the denominator for reports such as “98.4% of retained `wikipedia.org` URLs contain `/wiki/`.”

Host and suffix observations are header-only: they are not emitted as generic body dictionary terms. This avoids counting the same host position twice (for example, as both a `.com/` body token and a header suffix state). Legacy schema-1 cubes may contain those old synthesized rows; the report generator removes exact header-resolved suffix forms and `www.` while retaining terms extracted from real paths and query strings.

Invariants:

- Dataset and context arrays are ordered dimensions. Consumers must use `signalIndex`; they must not infer positions from names.
- Cubes can be merged only when `schemaVersion`, `datasets`, `datasetFamilies`, and `contexts` match exactly.
- Counts are additive across cubes and collections.
- The cube contains aggregates, not messages or a URL dump. Held-out URL samples are a separate `--header-heldout` artifact.
- String counters are bounded by the metadata's `counterKeyLimit`; low-default-score tails may have been pruned. Raw counts for retained keys are exact.
- A scan run with `--header-only` intentionally omits character, length, path, query, term, and host-pattern observations.

The report manifest records every cube path and all effective weights. Reproducing a report requires the cubes and the manifest, not the source archives.
