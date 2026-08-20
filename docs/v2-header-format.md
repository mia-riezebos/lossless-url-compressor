# v2 variable-length header format

Status: **draft encoder/decoder implemented from the 2026-08-16 trained model; not production-frozen**.

The capacity model and shortlist search are implemented in the Rust trainer's `report` mode. `scripts/generate-v2-codec-model.ts` strips those reports into the committed runtime tables, and `src/v2-codec.ts` implements the header described below. v2 has wire version `0`, encoded as the single leading body bit `0`; future wire versions use `10`, `110`, and so on. Existing `/1/` payloads continue to use their current alphabet, model profile, and decoder unchanged.

The unary value is part of the independently radix-packed body bitstream, not a visible version character. The decoder first consumes the self-delimiting visible header, reverses the remaining radix body, consumes the unary version, and dispatches the remaining bits. Keeping header and body as separate radix fields preserves the measured 1/2/3 visible-character header capacities.

## Purpose

The v2 header moves frequent, structurally predictable URL information out of the general token stream:

- HTTP versus HTTPS;
- the exact `www.` prefix;
- a common public suffix or complete registrable host;
- a common final path basename such as `index.html` or `index.php`;
- the length of the header itself.

The shortlist optimizer models and the runtime emits the header as one, two, or three radix digits. There is no delimiter scan: the first digit selects the tier and therefore the exact header length. The remainder is a separately terminated radix body.

## Characters, digits, and bytes

The header is most accurately described as a sequence of **radix digits** or visible characters, not bytes.

- Every ASCII header character is one UTF-8 byte.
- Every CJK header character is normally three UTF-8 bytes but one visible Unicode character.
- Compression reports optimize visible URL characters, which is the metric relevant to short-link length and presentation.

Any binary serialization should be specified separately. The URL-surface decoder indexes Unicode characters into a fixed alphabet.

## Output modes

v2 trains a separate table for each carrier/alphabet combination:

| mode | alphabet | base `B` | outer fragment delimiter | decoder location |
| --- | --- | ---: | ---: | --- |
| ASCII server-safe | `ASCII_SERVER_ALPHABET` | 81 | 0 | server or client |
| ASCII + fragment | `ASCII_CLIENT_ALPHABET` | 82 | 1 | client |
| CJK | U+4E00 through U+9FFF | 20,992 | 0 | experimental; transport behavior must be verified |
| CJK + fragment | CJK range plus `#` | 20,993 | 1 | client |

The leading fragment delimiter in `http://piss.zip#<payload>` is carrier syntax and is not part of the variable header. There is no root slash before it. In fragment modes, later `#` characters may be radix digits because only the first `#` begins the browser fragment.

The four bases produce radically different capacities, so they must not share one shortlist.

## URL decomposition

The encoder accepts only absolute HTTP and HTTPS URLs and performs the existing safe normalization:

- lowercase scheme;
- lowercase host;
- preserve userinfo, port, path, query, fragment, percent spelling, and path casing;
- do not use a URL API that silently rewrites path/query/fragment bytes.

For header planning, the normalized URL is decomposed as:

```text
scheme://[www.][other-subdomains.]registrable-host[:port]/path?query#fragment
```

The header removes only fields it explicitly represents. Everything else remains in the body token stream.

Unusual authorities, IP literals, userinfo, and ambiguous ports may always use the raw-host selector. Canonical host/suffix compaction should be disabled unless the encoder can reverse it byte-for-byte after the permitted scheme/host normalization.

## The 4-bit structural state

Every header-table entry is combined with one of 16 structural states:

| bits | field | values |
| --- | --- | --- |
| bit 0 | protocol | `0` = HTTP, `1` = HTTPS |
| bit 1 | `www.` | `0` = not stripped, `1` = exact leading `www.` stripped and restored by decoder |
| bits 2–3 | final path basename | `00` = raw/no special basename, `01` = `index.html`, `10` = `index.php`, `11` = reserved |

With `https`, `www`, and `fileCode` represented as integers:

```text
structure = https | (www << 1) | (fileCode << 2)
```

`fileCode = 0` does **not** assert that the path has no filename. It means the header did not remove a recognized special basename. Any other basename remains literal body data.

When `index.html` or `index.php` is selected, the encoder removes that exact final path segment and the decoder reinserts it immediately before `?`, `#`, or the end of the URL. A match in the middle of a path segment is not eligible.

## Shared selector namespace

A selector is one of:

- `raw`: the body retains the complete host after any separately encoded `www.` prefix;
- `suffix`: the body omits a public suffix such as `.com` or `.co.uk`;
- `host`: the body omits a complete registrable host such as `youtube.com`.

Suffixes and hosts occupy the same table. Encoding `youtube.com` already implies `.com`; emitting both would waste state and create ambiguous reconstruction.

For a selected exact host, an unrecognized subdomain remains in the body. For example, a `youtube.com` symbol can represent both `youtube.com` and `m.youtube.com`; the residual authority for the latter retains `m.`. The dedicated `www` bit is used only for the exact `www.` prefix.

## Compact one-character header

ASCII reserves the first 64 alphabet values for the compact case. Those six bits are conceptually:

```text
bits 5–4: selector  00 raw, 01 .com, 10 .net, 11 .org
bits 3–0: structure protocol/www/file state
```

Equivalently:

```text
compactValue = selector * 16 + structure
```

The canonical selector order is:

| selector | meaning |
| ---: | --- |
| 0 | raw host |
| 1 | `.com` |
| 2 | `.net` |
| 3 | `.org` |

`compactValue` ranges from 0 through 63 and is emitted as `alphabet[compactValue]`. In the current ASCII alphabet, those positions are `A-Z`, `a-z`, `0-9`, `-`, and `.`.

This is why the common case needs six logical bits even though the physical carrier is base 81 or base 82: the unused first-character values announce extended headers.

## Variable-length lead ranges

Let:

- `B` be the mode's alphabet size;
- `S = 16` be the number of structural states;
- `N1` be the number of dedicated one-character host/suffix entries;
- `L1 = S * (N1 + 1)` be the one-character lead states, including raw fallback;
- `L2` be the number of first-character digits assigned to two-character headers;
- `L3` be the number assigned to three-character headers;
- `G = 1` be a reserved generic/escape lead;
- `U = B - G - L1 - L2 - L3` be unused/reserved leads.

The proposed first-character layout is contiguous:

```text
[ one-character states ][ two-character leads ][ three-character leads ][ unused ][ generic ]
0                    L1                    ...                      ...       B-1
```

The exact range boundaries and the meaning of the generic lead must be frozen with the generated table. The current optimizer reserves its capacity but does not yet define its wire behavior.

The first character alone determines header length:

- in the one-character range, consume one character;
- in the two-character range, consume exactly two;
- in the three-character range, consume exactly three;
- unused values are invalid;
- the generic lead invokes its separately versioned behavior.

No extended header can start with a compact lead, so modes cannot overlap even when their second or third characters happen to equal compact header characters.

## Capacity

An extended header packs a table entry and the 4-bit structural state into a mixed-radix integer.

```text
tier2Capacity = floor(L2 * B / 16)
tier3Capacity = floor(L3 * B * B / 16)
```

One additional two-character lead creates approximately `B / 16` entries. One three-character lead creates approximately `B² / 16` entries. This is the tradeoff the lead-split optimizer searches.

With the compact raw/`.com`/`.net`/`.org` allocation fixed, the maximum number of candidates reachable with at most two characters is:

| mode | one-character selected entries | selected entries reachable through two characters |
| --- | ---: | ---: |
| ASCII, base 81 | 3 fixed suffixes plus raw | 84 suffix/host entries plus raw |
| ASCII + fragment, base 82 | 3 fixed suffixes plus raw | 90 suffix/host entries plus raw |
| CJK, base 20,992 | up to 1,310 suffix/host entries plus raw | about 27.46 million plus raw |
| CJK + fragment, base 20,993 | up to 1,311 suffix/host entries plus raw | about 27.46 million plus raw |

The CJK figures explain why a three-character CJK header may be counterproductive: two characters can already address every realistic host/suffix candidate set. A one-character CJK header can itself hold more than a thousand dedicated entries. The optimizer must compare actual expected savings, not allocate a third character merely because the theoretical space exists.

The extra `#` radix digit in CJK+fragment mode is meaningful. It raises the base from 20,992 to 20,993 and permits one additional fully populated one-character selector block.

## Extended-header encoding

For a table entry index `entry` within a tier and structural state `structure`:

```text
packed = entry * 16 + structure
```

For a two-character tier whose first-character range starts at `start2`:

```text
localFirst = floor(packed / B)
digit1     = packed % B
digit0     = start2 + localFirst

header = alphabet[digit0] + alphabet[digit1]
```

For a three-character tier starting at `start3`:

```text
localFirst = floor(packed / (B * B))
remainder  = packed % (B * B)
digit1     = floor(remainder / B)
digit2     = remainder % B
digit0     = start3 + localFirst

header = alphabet[digit0] + alphabet[digit1] + alphabet[digit2]
```

Only entry indexes below the declared tier capacity are valid. Mixed-radix values in the unused tail of a lead range must be rejected rather than aliased.

## Header decoder algorithm

The decoder does not search for the end of the header.

1. Detect the carrier and alphabet from the URL surface.
2. Select the frozen table for that carrier/alphabet mode.
3. Read the header tier and its one-, two-, or three-digit packed state.
5. Recover `packed` from that mixed-radix state.
6. Compute:

   ```text
   entry     = floor(packed / 16)
   structure = packed % 16
   ```

7. Reverse the remaining radix body, consume unary wire version `0`, and decode the body token stream.
8. Split the decoded residual body at its first `/`, `?`, or `#`; this is the authority/tail boundary already used by URL syntax.
9. Restore the selected suffix or host inside the authority.
10. Restore `www.` when its bit is set.
11. Reinsert the selected final basename before query/fragment.
12. Prepend `http://` or `https://` from the protocol bit.
13. Reject non-canonical encodings whose decoded URL would re-encode differently.

The host/path boundary therefore does not require another header tag. It appears in the decoded residual body as the normal URL delimiter. The header length and the body boundary solve different problems.

## Worked compact examples

These examples show the unencoded residual body for readability. In the actual codec, the residual is passed through the v2 token/bit/radix body encoder.

### HTTPS plus `.com`

Input:

```text
https://example.com/articles
```

Fields:

```text
https      = 1
www        = 0
fileCode   = 0
structure  = 0001₂ = 1
selector   = .com = 1
packed     = 1 * 16 + 1 = 17
```

ASCII alphabet index 17 is `R`, so:

```text
header:   R
residual: example/articles
```

After body decoding, the decoder restores `.com`, the `/articles` tail, and `https://`.

### HTTP, `www.`, `.org`, and `index.php`

Input:

```text
http://www.example.org/docs/index.php?q=1
```

Fields:

```text
https      = 0
www        = 1
fileCode   = 2
structure  = 1010₂ = 10
selector   = .org = 3
packed     = 3 * 16 + 10 = 58
```

ASCII alphabet index 58 is `6`:

```text
header:   6
residual: example/docs/?q=1
```

The decoder restores `.org`, prefixes `www.`, inserts `index.php` before `?q=1`, and prefixes `http://`.

### Raw host fallback

Input:

```text
https://blog.example.dev/a
```

If neither `.dev` nor `example.dev` is selected:

```text
structure = 1
selector  = raw = 0
packed    = 1
header    = B
residual  = blog.example.dev/a
```

The body retains the complete host, so every valid HTTP(S) URL remains representable.

## Illustrative two-character example

Assume an ASCII table with:

- base `B = 81`;
- compact range `0..63`;
- two-character range starting at 64 with 15 lead digits;
- three-character range using the next lead digit;
- the final digit reserved as generic escape.

For tier-two entry 5 and structural state 7:

```text
packed     = 5 * 16 + 7 = 87
localFirst = floor(87 / 81) = 1
digit1     = 87 % 81 = 6
digit0     = 64 + 1 = 65
```

ASCII alphabet indexes 65 and 6 are `~` and `G`, so the header is `~G`. The decoder sees `~` in the two-character range and consumes exactly one additional character. The same `G` could appear in a compact header elsewhere without ambiguity because only the first digit selects the mode.

This allocation is illustrative. Final lead counts and candidate indexes come from the frozen per-mode generated table.

## Body reconstruction rules

The body begins immediately after the header. It contains the residual normalized authority followed by the original path/query/fragment tail, less any selected final basename.

Canonical transformations are applied in this order:

### Encoding

1. Normalize scheme and host.
2. Split scheme, authority, and tail.
3. Strip an exact leading `www.` when profitable.
4. Choose exactly one of raw, suffix, or complete-host selectors.
5. Strip an eligible final `index.html` or `index.php` path segment.
6. Encode the resulting residual body.
7. Prefix the selected header.

### Decoding

1. Decode the variable-length header and obtain its raw, suffix, or exact-host selector.
2. Decode the residual body. An exact-host selector also chooses that host's trained route table, so route symbols need no separate host marker in the body.
3. Recover the authority/tail boundary.
4. Restore the selected host or suffix.
5. Restore `www.` and the final basename.
6. Restore the scheme.

Encoder choice must be deterministic when several candidates match. The intended rule is to evaluate the complete encoded result and choose the shortest; ties must use a frozen stable order. A decoder never makes this choice—it follows the selector table entry.

Top-level residual symbols use a frozen canonical, length-limited Huffman code selected by carrier mode. Only the 64 code lengths are generated; canonical ordering derives every bit pattern deterministically. The decoder already knows the mode from the payload surface, and no per-URL tree metadata is transmitted. Token payloads such as route IDs, structured suffixes, numeric values, and LZ reference offset/length fields follow their Huffman-coded top-level symbol.

## Table format requirements

Each codec mode needs a generated descriptor containing at least:

```ts
type HeaderTable = {
  alphabetId: string;
  base: number;
  structuralStates: 16;
  genericLead: number;
  oneCharacterEnd: number;
  twoCharacterStart: number;
  twoCharacterLeadCount: number;
  threeCharacterStart: number;
  threeCharacterLeadCount: number;
  tier1: HeaderEntry[];
  tier2: HeaderEntry[];
  tier3: HeaderEntry[];
};

type HeaderEntry =
  | { kind: "raw" }
  | { kind: "suffix"; value: string }
  | { kind: "host"; value: string };
```

The generated file must include a schema/version identifier and content hash. Encoder and decoder must import the same artifact. Reordering entries changes every affected payload and therefore requires a new codec version.

## Validation before deployment

The wire format is ready to freeze only after:

1. exhaustive round trips for all structural states and every valid table entry;
2. rejection tests for unused lead values and partially populated mixed-radix tails;
3. property tests over arbitrary normalized HTTP(S) URLs;
4. transport tests through browsers, Cloudflare, logs, redirects, copy/paste, and QR scanners for all four alphabets;
5. canonical re-encoding tests;
6. held-out compression comparisons against `/1/` (implemented; rerun before every model freeze);
7. a decision on the generic escape lead;
8. a decision on whether non-fragment CJK is operationally safe enough to expose;
9. frozen, committed header tables with reproducible training metadata.

The draft now exercises every non-reserved structural-state combination, representative entries in every populated tier, malformed tails, the generated tables, and weighted held-out comparisons in all four carrier modes. Exhaustive round trips over every one of the 50,000 CJK entries, transport testing, and the production freeze decision remain open, so the generated model is still a model-selection draft rather than a compatibility promise.
