#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import re
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

INSERT_RE = re.compile(r"\((\d+),(\d+),'((?:\\.|[^'])*)','((?:\\.|[^'])*)'\)")
COMMON_LITERAL_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-._/?&=:@+%#"

# Keep this bounded: full enwiki has too many one-off path/query strings for exact Counters.
MAX_KEY_LEN = 80
MAX_CANDIDATE_KEYS = 500_000


def mysql_unescape(value: str) -> str:
    out: list[str] = []
    i = 0
    escapes = {"0": "\0", "'": "'", '"': '"', "b": "\b", "n": "\n", "r": "\r", "t": "\t", "Z": "\x1a", "\\": "\\"}
    while i < len(value):
        if value[i] == "\\" and i + 1 < len(value):
            i += 1
            out.append(escapes.get(value[i], value[i]))
        else:
            out.append(value[i])
        i += 1
    return "".join(out)


def domain_index_to_url(domain_index: str, path: str) -> str | None:
    if "://" not in domain_index:
        return None
    scheme, reversed_host = domain_index.split("://", 1)
    labels = [label for label in reversed_host.rstrip(".").split(".") if label]
    if not labels:
        return None
    return f"{scheme.lower()}://{'.'.join(reversed(labels)).lower()}{path}"


def iter_urls(path: Path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.startswith("INSERT INTO"):
                continue
            for match in INSERT_RE.finditer(line):
                url = domain_index_to_url(mysql_unescape(match.group(3)), mysql_unescape(match.group(4)))
                if url:
                    yield url


def body(url: str) -> str:
    return url[len("https://") :] if url.startswith("https://") else url


def literal_bits(text: str) -> int:
    return sum(6 if char in COMMON_LITERAL_ALPHABET else 13 for char in text)


def bump(counter: collections.Counter[str], key: str, amount: int = 1) -> None:
    if 1 <= len(key) <= MAX_KEY_LEN:
        counter[key] += amount
        prune_counter(counter)


def prune_counter(counter: collections.Counter[str]) -> None:
    if len(counter) <= MAX_CANDIDATE_KEYS:
        return

    for threshold in (1, 2, 3, 5):
        for key, count in list(counter.items()):
            if count <= threshold:
                del counter[key]
        if len(counter) <= MAX_CANDIDATE_KEYS:
            return

    for key, _ in counter.most_common()[:-MAX_CANDIDATE_KEYS]:
        del counter[key]


def add_candidates(url_body: str, split, candidates: collections.Counter[str]) -> None:
    host = split.hostname or ""
    path = split.path or ""

    for prefix in ("http://", "http://www.", "https://", "https://www.", "www."):
        if url_body.startswith(prefix):
            bump(candidates, prefix)

    labels = host.split(".") if host else []
    for size in range(1, min(3, len(labels)) + 1):
        suffix = ".".join(labels[-size:])
        bump(candidates, f".{suffix}")
        if path.startswith("/"):
            bump(candidates, f".{suffix}/")

    subdomain_labels = labels[: max(0, len(labels) - 2)]
    for label in subdomain_labels:
        if 1 <= len(label) <= MAX_KEY_LEN:
            bump(candidates, f"{label}.")
    for size in range(2, min(4, len(subdomain_labels)) + 1):
        for start in range(0, len(subdomain_labels) - size + 1):
            bump(candidates, ".".join(subdomain_labels[start:start + size]) + ".")

    segments = [segment for segment in path.split("/") if segment and len(segment) <= MAX_KEY_LEN]
    for segment in segments:
        bump(candidates, segment)
        bump(candidates, f"/{segment}")
        bump(candidates, f"/{segment}/")
        dot = segment.rfind(".")
        if 0 < dot < len(segment) - 1:
            bump(candidates, segment[dot:])

    for size in range(2, min(5, len(segments)) + 1):
        for start in range(0, len(segments) - size + 1):
            phrase = "/" + "/".join(segments[start:start + size])
            bump(candidates, phrase)
            bump(candidates, f"{phrase}/")

    query_keys = [key for key, _ in parse_qsl(split.query, keep_blank_values=True) if 1 <= len(key) <= MAX_KEY_LEN]
    for key in query_keys:
        bump(candidates, f"?{key}=")
        bump(candidates, f"&{key}=")
        bump(candidates, f"{key}=")
    for size in range(2, min(4, len(query_keys)) + 1):
        for start in range(0, len(query_keys) - size + 1):
            phrase = "?" + "=&".join(query_keys[start:start + size]) + "="
            bump(candidates, phrase)


def top_table(counter: collections.Counter[str], limit: int) -> list[str]:
    return [f"| `{k}` | {v} |" for k, v in counter.most_common(limit)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dump", type=Path)
    parser.add_argument("--limit", type=int, default=2_000_000)
    parser.add_argument("--sample-every", type=int, default=1)
    parser.add_argument("--top", type=int, default=80)
    parser.add_argument("--out", type=Path, default=Path("data/wiki/enwiki-analysis.md"))
    args = parser.parse_args()

    schemes: collections.Counter[str] = collections.Counter()
    hosts: collections.Counter[str] = collections.Counter()
    tlds: collections.Counter[str] = collections.Counter()
    chars: collections.Counter[str] = collections.Counter()
    path_segments: collections.Counter[str] = collections.Counter()
    query_keys: collections.Counter[str] = collections.Counter()
    candidates: collections.Counter[str] = collections.Counter()
    lengths: list[int] = []

    seen = sampled = 0
    for url in iter_urls(args.dump):
        seen += 1
        if seen % args.sample_every != 0:
            continue
        sampled += 1
        if args.limit and sampled > args.limit:
            sampled -= 1
            break

        url_body = body(url)
        split = urlsplit(url)
        schemes[split.scheme] += 1
        if split.hostname:
            hosts[split.hostname] += 1
            tlds[split.hostname.rsplit(".", 1)[-1]] += 1
        chars.update(url_body)
        lengths.append(len(url_body))

        for segment in split.path.split("/"):
            bump(path_segments, segment)
        for key, _ in parse_qsl(split.query, keep_blank_values=True):
            bump(query_keys, key)
        add_candidates(url_body, split, candidates)

    scored = []
    for candidate, count in candidates.items():
        if count < 5 or len(candidate) < 2:
            continue
        saved_each = literal_bits(candidate) - 12  # extended dict cost; primary dict is even cheaper
        if saved_each > 0:
            scored.append((count * saved_each, candidate, count, saved_each))
    scored.sort(reverse=True)

    sorted_lengths = sorted(lengths)
    def pct(p: float) -> int:
        if not sorted_lengths:
            return 0
        return sorted_lengths[min(len(sorted_lengths) - 1, int(len(sorted_lengths) * p))]

    lines = [
        "# enwiki externallinks analysis",
        "",
        f"Rows seen: {seen}",
        f"Rows sampled: {sampled}",
        f"Sample every: {args.sample_every}",
        f"Body length p50/p90/p99: {pct(0.50)} / {pct(0.90)} / {pct(0.99)}",
        "",
        "## Schemes", "| value | count |", "| --- | ---: |", *top_table(schemes, 12),
        "", "## Top hosts", "| value | count |", "| --- | ---: |", *top_table(hosts, args.top),
        "", "## Top TLDs", "| value | count |", "| --- | ---: |", *top_table(tlds, 40),
        "", "## Top path segments", "| value | count |", "| --- | ---: |", *top_table(path_segments, args.top),
        "", "## Top query keys", "| value | count |", "| --- | ---: |", *top_table(query_keys, args.top),
        "", "## Top candidate dictionary entries", "| candidate | count | saved bits/use | total score |", "| --- | ---: | ---: | ---: |",
        *(f"| `{candidate}` | {count} | {saved_each} | {score} |" for score, candidate, count, saved_each in scored[: args.top]),
        "", "## Top body characters", "| char | count |", "| --- | ---: |",
        *(f"| `{repr(char)[1:-1]}` | {count} |" for char, count in chars.most_common(100)),
    ]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {args.out} (seen={seen}, sampled={sampled})")


if __name__ == "__main__":
    main()
