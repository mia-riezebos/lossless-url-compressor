# Stateless Lossless URL Compressor — WIP Spec

## Goal

Create a deterministic, stateless, lossless URL compressor for links under:

```txt
https://l.mia.cx/<version>/<payload-surface>
```

The compressed URL must be decodable by any conforming client or server with no database, disk, lookup service, or per-link state.

This is not a conventional shortener. Short inputs may produce longer output, especially after adding the `https://l.mia.cx/` origin. That is acceptable.

## Non-goals

- No database-backed short codes.
- No opaque random IDs.
- No server-side storage.
- No binary compressor output that then requires a separate URI/base64 escaping layer.

## Core requirements

1. **Stateless**: the payload contains everything needed to recover the destination URL.
2. **Deterministic**: same normalized input always produces the same compressed payload.
3. **Lossless after approved normalization**: decoding restores the normalized URL exactly.
4. **URL-native output**: the compression algorithm emits URL-transportable characters directly.
5. **Versioned**: algorithms can change behind path versions like `/0/`, `/1/`, etc.
6. **Server/client modes**:
   - server-safe mode: server can read the complete token and redirect.
   - client-max mode: token may use `#`; browser JS must decode because fragments are not sent to the server.
7. **ASCII-safe MVP first**: version `0` prioritizes a strict ASCII URL-surface codec. Unicode/CJK-dense modes are deferred.

## Input normalization

Input must be a valid URL.

Before compression:

1. Normalize the scheme to lowercase.
2. Normalize the host/domain/subdomains/TLD to lowercase.
3. Preserve every other component exactly:
   - username
   - password
   - port
   - path casing and spelling
   - query casing, order, separators, and spelling
   - fragment casing and spelling

Then apply HTTPS omission:

- If the normalized scheme is `https`, omit `https://` from the compressed source stream.
- Otherwise encode the explicit `<scheme>://` prefix.

Examples:

```txt
HTTPS://EXAMPLE.COM/Foo?A=B
=> example.com/Foo?A=B
=> decodes to https://example.com/Foo?A=B
```

```txt
HtTpS://Sub.Example.COM/a#Frag
=> sub.example.com/a#Frag
=> decodes to https://sub.example.com/a#Frag
```

```txt
HTTP://EXAMPLE.COM/Foo
=> explicit http:// + example.com/Foo
=> decodes to http://example.com/Foo
```

Scheme and host byte-exact casing is intentionally not preserved because URL schemes and hosts are case-insensitive.

Open implementation detail: avoid URL parser APIs that accidentally normalize path/query/fragment percent-encoding or other bytes beyond scheme and host.

## Compressed URL shape

The stable outer route is:

```txt
https://l.mia.cx/<version>/<payload-surface>
```

Example version prefix:

```txt
https://l.mia.cx/0/...
```

`<payload-surface>` is not semantically divided into path/query/fragment fields. It is the opaque serialized URL surface after `/0/`.

The codec may use URL feature characters as plain compression alphabet symbols, including characters that normally have URL structure meaning.

Examples of acceptable-looking payload surfaces, subject to mode/alphabet rules:

```txt
https://l.mia.cx/0/hiOEU87?jfkd#nfcj&dkd
https://l.mia.cx/0/a/b?c/d?e=f#g/h?i
https://l.mia.cx/0//?#?#?/#??#?//#?
```

## URL feature character semantics

We are not using URL features according to their normal meaning. We are using the serialized characters as a transport surface.

Still, browser/server parsing imposes these facts:

1. The first `?` starts the query.
2. Later `?` characters are just query or fragment data.
3. The first `#` starts the fragment.
4. Later `#` characters are fragment data visible to client JS.
5. The server never receives the first `#` or anything after it.
6. `/` after `?` or `#` is just data, not a path separator in the parsed URL model.
7. `&` is safe as a transported character; query parsers may treat it as a parameter separator, so implementations must read the raw URL/search string rather than parsed query maps.

Examples:

```txt
https://l.mia.cx/0/a?b?c?d
```

Server-visible raw target includes:

```txt
/0/a?b?c?d
```

```txt
https://l.mia.cx/0/a#b#c#d
```

Client JS sees:

```js
location.hash === "#b#c#d"
```

Server sees only:

```txt
/0/a
```

## Carrier modes

### Server-safe mode

The encoder must not emit the first `#` delimiter in the payload surface.

The server decodes from raw path plus raw search/query:

```txt
pathname + search
```

This mode supports immediate HTTP redirects.

### Client-max mode

The encoder may emit `#`.

The client decodes from:

```txt
pathname + search + hash
```

This mode may be shorter because fragment characters are available, but it requires a client-side app/JS redirect. The server cannot decode the full payload if any compressed data appears after the first `#`.

UI must expose this as an explicit toggle, e.g.:

```txt
[ ] Allow fragment payload: shorter, client-side redirect only
```

## Alphabet policy

Allowed characters are characters that are valid in a URL and survive transport from generated link to decoder.

The codec may use reserved URL characters as compression symbols when they are observable by the target decoder mode.

### ASCII-safe alphabet

The MVP targets a strict ASCII URL-surface alphabet:

```txt
A-Z a-z 0-9
- . _ ~
! $ & ' ( ) * + , ; = : @
/ ?
#   client-max mode only
```

Raw `%` is excluded from the ASCII-safe MVP alphabet because it starts percent-encoding and is commonly normalized/decoded by URL tooling.

Implementations must avoid parsed query-parameter APIs for payload decoding, because characters like `&` and `=` are compression symbols, not actual parameter delimiters.

### Future Unicode/CJK alphabet

A future mode may use Unicode/IRI characters, including CJK-heavy alphabets similar to base32768, to maximize visible information per character in client-side contexts.

This mode is not server-safe by default. Browsers commonly serialize Unicode URL characters as UTF-8 percent escapes in HTTP requests, so one visible Unicode character may become many ASCII bytes on the wire. It is mainly useful for fragment/client-side decoding or apps that count visible characters.

### Implicit alphabet/mode detection

The decoder infers payload family from characters instead of adding an explicit alphabet flag.

Payload-family discriminator:

```txt
if payload-surface contains "%" OR any non-ASCII character:
  payload family = Unicode/CJK
else:
  payload family = ASCII-safe
```

Carrier discriminator:

```txt
if full compressed URL contains "#":
  carrier = client-max; decode in browser/client JS
else:
  carrier = server-safe; server may decode and redirect
```

Therefore ASCII-safe encoders must never emit raw `%` or non-ASCII characters. Unicode/CJK encoders own both raw `%` and all non-ASCII characters.

This keeps common ASCII-safe links short while leaving room for denser experimental alphabets later.

## Compression algorithm direction

Version `0` starts as an ASCII-safe proof of concept, but the intended architecture is an actual string-compression pipeline rather than a hand-written state machine with many bespoke branches.

Preferred conceptual pipeline:

```txt
input URL
=> normalize scheme + host
=> omit https:// if applicable
=> tokenize normalized source stream
=> entropy-code token stream
=> radix/base-N emit into URL-observable alphabet
```

Compression-specific URL knowledge should live in the tokenizer/model. The bitstream coder should be generic.

Target module boundaries:

```txt
normalizer   scheme/host normalization + https omission
tokenizer    deterministic parser over literals, dictionary phrases, numbers, and LZ refs
model        shared static dictionary + token frequencies/probabilities
coder        range/ANS/arithmetic-style token coder
radix        URL alphabet output/input
codec        glue only
```

Uniform token shape:

```ts
type Token =
  | { type: "lit"; value: string }
  | { type: "dict"; id: number }
  | { type: "num"; value: bigint }
  | { type: "ref"; offset: number; length: number };
```

The tokenizer may use URL segment awareness, but decoder complexity should remain concentrated in token interpretation rather than URL-specific bitstream branches.

### Token budget and no-expansion parsing

Each codec version must define a hard token budget before training the model. The MVP currently uses 6-bit top-level symbols, so at most 64 symbols can exist in the primary token alphabet.

Those symbols must cover:

- common literal characters
- primary dictionary entries
- escape token for uncommon ASCII literals
- numeric-run token
- LZ/reference token
- extended-dictionary token
- end token

The extended-dictionary token may point into a secondary table, but that secondary reference has its own explicit bit cost. Dictionary size is therefore not free: every dictionary tier must be costed by the tokenizer and justified by corpus savings.

The tokenizer must use an optimal parse over candidate tokens with accurate bit costs. It must not choose a token when that token costs more than encoding the same substring as literals. Ties should prefer the literal/raw parse to avoid unnecessary model coupling.

Training should score candidates against the actual budget:

```txt
primary dictionary saving  = literal_bits(phrase) - primary_token_bits
extended dictionary saving = literal_bits(phrase) - extended_token_bits
```

A phrase is eligible only if its saving is positive under the tier where it would live. This keeps rare or too-short dictionary entries from making encoded output longer.

Initial token tools:

1. Literal runs over allowed URL characters.
2. Static dictionary references for common URL substrings.
3. Numeric-run tokens for long decimal/hex/base-like IDs.
4. Dynamic LZ/LZSS backreferences for repeated substrings.
5. Compact entropy/radix coding using URL-observable alphabet symbols.

A strong future shape is LZSS with a static URL dictionary preloaded into the history window, then entropy-coded with range coding, ANS, or another deterministic coder. Static dictionary phrases then behave like normal backreferences instead of requiring many special command branches.

Candidate static dictionary entries:

```txt
www.
.com
.org
.net
.io
.dev
.app
.co
x.com/
twitter.com/
github.com/
youtube.com/
youtu.be/
reddit.com/
/status/
/users/
@github
?utm_
utm_source=
utm_medium=
utm_campaign=
&ref=
```

After a working demo exists, replace hand-tuned choices with a trained dictionary and measured token model from a real URL corpus.

## Versioning

The first path segment after the origin is the codec version.

```txt
https://l.mia.cx/0/<payload-surface>
https://l.mia.cx/1/<payload-surface>
```

A version defines:

- normalization rules
- carrier mode encoding flags
- alphabet
- dictionary
- integer coding
- token grammar
- decode algorithm

Old versions must remain decodable indefinitely.

## Reference project comparison

The project that inspired this is `yanorei32/url-compressor`:

```txt
https://github.com/yanorei32/url-compressor
```

Observed behavior:

- Rust/WASM.
- `encode` = zstd level 20 over UTF-8 bytes, then base32768.
- `decode` = base32768 decode, then zstd decode.
- Compressed payload is stored in the fragment: `https://uc.yr32.net/#<payload>`.
- Decode/redirect is client-side because fragments are not sent to servers.

Our project differs:

| Area | Reference | This spec |
| --- | --- | --- |
| State | Stateless | Stateless |
| Compression | zstd bytes | URL-native grammar/LZ first |
| Text encoding | base32768 Unicode armor | URL-valid characters emitted directly |
| Payload location | Fragment only | Server-safe or client-max toggle |
| Server redirect | No | Yes in server-safe mode |
| HTTPS handling | Preserved | Omitted after scheme normalization |
| Host casing | Preserved by generic compressor | Normalized lowercase |
| Versioning | No route version | Required route version |

## Corpus and trained model

Use a large real URL corpus to train dictionaries, token frequencies, and regression benchmarks.

Primary corpus candidate: English Wikipedia `externallinks` dump.

Download:

```txt
https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-externallinks.sql.gz
```

Index:

```txt
https://dumps.wikimedia.org/enwiki/latest/
```

Current observed compressed size is under 5 GB. The dump is SQL; extraction tooling should stream it rather than fully loading it into memory.

Useful first commands:

```sh
mkdir -p data/wiki
cd data/wiki
curl -LO https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-externallinks.sql.gz
curl -LO https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-externallinks.sql.gz.md5
md5sum -c enwiki-latest-externallinks.sql.gz.md5
```

Smaller dry-run corpus:

```txt
https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-externallinks.sql.gz
```

Training goals:

1. Find high-value static dictionary substrings by held-out marginal savings, not raw count.
2. Estimate token probabilities for entropy coding.
3. Measure compression ratios by URL class and length bucket.
4. Detect regressions across versions.
5. Compare server-safe vs client-max alphabets.

Dictionary selection rule:

```txt
net_gain = heldout_marginal_saved_bits - dictionary_entry_cost_bits
```

Candidates are selected greedily by current marginal gain after previously selected tokens have claimed their spans. This handles overlap naturally: if `.com/` covers nearly all useful `.com` occurrences, `.com` becomes shadowed and should not consume another slot. Long entries must repay their model bytes on held-out URLs, not just appear frequently in the training split.

### Anti-overfit training policy

The shared model should not overfit to a few high-frequency domains in the corpus, such as archive.org, YouTube, Google, or other citation-heavy sites.

For v0/v1 training, prefer generic URL structure over exact hostnames:

- TLDs and public suffix-like endings: `.com`, `.org`, `.co.uk`, `.gov.au`.
- Common subdomain labels: `www.`, `m.`, `api.`, `docs.`, `news.`, `books.`, `maps.`.
- Host-shape patterns: repeated labels, country-code suffixes, `www.` prefix.
- Path segment patterns: `/news/`, `/search/`, `/article/`, `/index.php`, `.html`, `.pdf`.
- Query-key patterns: `?id=`, `&id=`, `?q=`, `&q=`, `page=`, `lang=`.
- Numeric/date/ID runs.

Avoid exact registered-domain entries in the general model unless they represent syntax-like infrastructure rather than a specific website. Examples to avoid in the generic dictionary:

```txt
web.archive.org
youtube.com
google.com
facebook.com
nytimes.com
```

A later optional site-pack/version may add exact-domain models, but the MVP general codec should be domain-neutral.

## MVP priority

Build version `0` as ASCII-safe first.

Defer:

- Unicode/CJK/base32768-like mode.
- Raw `%` payload mode.
- Full range/ANS entropy coding until the demo and corpus harness exist.

## Open questions

1. Exact v0 ASCII-safe alphabet after transport tests.
2. How to minimally parse URLs for scheme/host normalization without altering path/query/fragment.
3. Initial dictionary contents and ordering before corpus training.
4. Entropy coder choice: range coder, ANS, arithmetic-style, or simpler interim packed coding.
5. Integer/numeric-run coding scheme.
6. Corpus extraction pipeline and benchmark format.
7. Future Unicode/CJK mode design and whether it is fragment-only or also supports escaped server-visible transport.
