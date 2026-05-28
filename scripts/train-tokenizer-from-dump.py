#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import re
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

INSERT_RE = re.compile(r"\((\d+),(\d+),'((?:\\.|[^'])*)','((?:\\.|[^'])*)'\)")
DICT_ROW = re.compile(r"\| `(.+)` \| (\d+) \| (\d+) \| (\d+) \|")
COMMON_LITERAL_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-._/?&=:@+%#ABCDEFGHIJKLMNOPQRSTUVWXYZ~!$'()*,;"
MAX_KEY_LEN = 80


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


def parse_seed_candidates(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    return {match.group(1) for match in DICT_ROW.finditer(text)}


def bump_if_seed(counter: collections.Counter[str], seeds: set[str], key: str) -> None:
    if key in seeds:
        counter[key] += 1


def add_seeded_candidates(url_body: str, split, seeds: set[str], candidates: collections.Counter[str]) -> None:
    host = split.hostname or ""
    path = split.path or ""

    for prefix in ("http://", "http://www.", "https://", "https://www.", "www."):
        if url_body.startswith(prefix):
            bump_if_seed(candidates, seeds, prefix)

    labels = host.split(".") if host else []
    for size in range(1, min(3, len(labels)) + 1):
        suffix = ".".join(labels[-size:])
        bump_if_seed(candidates, seeds, f".{suffix}")
        if path.startswith("/"):
            bump_if_seed(candidates, seeds, f".{suffix}/")

    subdomain_labels = labels[: max(0, len(labels) - 2)]
    for label in subdomain_labels:
        bump_if_seed(candidates, seeds, f"{label}.")
    for size in range(2, min(4, len(subdomain_labels)) + 1):
        for start in range(0, len(subdomain_labels) - size + 1):
            bump_if_seed(candidates, seeds, ".".join(subdomain_labels[start:start + size]) + ".")

    segments = [segment for segment in path.split("/") if segment and len(segment) <= MAX_KEY_LEN]
    for segment in segments:
        bump_if_seed(candidates, seeds, segment)
        bump_if_seed(candidates, seeds, f"/{segment}")
        bump_if_seed(candidates, seeds, f"/{segment}/")
        dot = segment.rfind(".")
        if 0 < dot < len(segment) - 1:
            bump_if_seed(candidates, seeds, segment[dot:])

    for size in range(2, min(5, len(segments)) + 1):
        for start in range(0, len(segments) - size + 1):
            phrase = "/" + "/".join(segments[start:start + size])
            bump_if_seed(candidates, seeds, phrase)
            bump_if_seed(candidates, seeds, f"{phrase}/")

    query_keys = [key for key, _ in parse_qsl(split.query, keep_blank_values=True) if 1 <= len(key) <= MAX_KEY_LEN]
    for key in query_keys:
        bump_if_seed(candidates, seeds, f"?{key}=")
        bump_if_seed(candidates, seeds, f"&{key}=")
        bump_if_seed(candidates, seeds, f"{key}=")
    for size in range(2, min(4, len(query_keys)) + 1):
        for start in range(0, len(query_keys) - size + 1):
            phrase = "?" + "=&".join(query_keys[start:start + size]) + "="
            bump_if_seed(candidates, seeds, phrase)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dump", type=Path)
    parser.add_argument("--seed-analysis", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("data/wiki/enwiki-trained-analysis.md"))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--top", type=int, default=120)
    args = parser.parse_args()

    seeds = parse_seed_candidates(args.seed_analysis)
    chars: collections.Counter[str] = collections.Counter()
    candidates: collections.Counter[str] = collections.Counter()
    lengths: list[int] = []
    total = 0

    for url in iter_urls(args.dump):
        total += 1
        if args.limit and total > args.limit:
            total -= 1
            break
        url_body = body(url)
        split = urlsplit(url)
        chars.update(url_body)
        lengths.append(len(url_body))
        add_seeded_candidates(url_body, split, seeds, candidates)

    scored = []
    for candidate, count in candidates.items():
        saved_each = literal_bits(candidate) - 12
        if saved_each > 0:
            scored.append((count * saved_each, candidate, count, saved_each))
    scored.sort(reverse=True)

    sorted_lengths = sorted(lengths)
    def pct(p: float) -> int:
        if not sorted_lengths:
            return 0
        return sorted_lengths[min(len(sorted_lengths) - 1, int(len(sorted_lengths) * p))]

    lines = [
        "# enwiki trained tokenizer analysis",
        "",
        f"Rows: {total}",
        f"Seed candidates: {len(seeds)} from {args.seed_analysis}",
        f"Body length p50/p90/p99: {pct(0.50)} / {pct(0.90)} / {pct(0.99)}",
        "",
        "## Top candidate dictionary entries",
        "| candidate | count | saved bits/use | total score |",
        "| --- | ---: | ---: | ---: |",
        *(f"| `{candidate}` | {count} | {saved_each} | {score} |" for score, candidate, count, saved_each in scored[: args.top]),
        "",
        "## Top body characters",
        "| char | count |",
        "| --- | ---: |",
        *(f"| `{repr(char)[1:-1]}` | {count} |" for char, count in chars.most_common(120) if ord(char) <= 0x7f and char != "`"),
    ]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {args.out} from {total} rows")


if __name__ == "__main__":
    main()
