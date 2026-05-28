#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import gzip
import re
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

INSERT_RE = re.compile(r"\((\d+),(\d+),'((?:\\.|[^'])*)','((?:\\.|[^'])*)'\)")
COMMON_LITERAL_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-._/?&=:@+,$"


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
    host = ".".join(reversed(labels)).lower()
    return f"{scheme.lower()}://{host}{path}"


def compression_body(url: str) -> str:
    return url[len("https://") :] if url.startswith("https://") else url


def iter_urls(path: Path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.startswith("INSERT INTO"):
                continue
            for match in INSERT_RE.finditer(line):
                domain_index = mysql_unescape(match.group(3))
                url_path = mysql_unescape(match.group(4))
                url = domain_index_to_url(domain_index, url_path)
                if url:
                    yield url


def literal_bits(text: str) -> int:
    return sum(6 if char in COMMON_LITERAL_ALPHABET else 13 for char in text)


def add_candidates(body: str, candidates: collections.Counter[str]) -> None:
    split = urlsplit(body if "://" in body else f"https://{body}")
    host = split.hostname or ""
    path = split.path or ""
    query = split.query or ""

    if body.startswith("http://"):
        candidates["http://"] += 1
    if body.startswith("https://"):
        candidates["https://"] += 1

    if host.startswith("www."):
        candidates["www."] += 1
        candidates["http://www."] += int(body.startswith("http://www."))
        candidates["https://www."] += int(body.startswith("https://www."))

    labels = host.split(".") if host else []
    for size in range(1, min(4, len(labels)) + 1):
        suffix = ".".join(labels[-size:])
        candidates[f".{suffix}"] += 1
        candidates[f".{suffix}/"] += int(path.startswith("/"))

    segments = [segment for segment in path.split("/") if segment]
    for segment in segments:
        if 2 <= len(segment) <= 32:
            candidates[segment] += 1
            candidates[f"/{segment}"] += 1
            candidates[f"/{segment}/"] += 1
        dot = segment.rfind(".")
        if 0 < dot < len(segment) - 1:
            ext = segment[dot:]
            if 2 <= len(ext) <= 8:
                candidates[ext] += 1

    for key, _ in parse_qsl(query, keep_blank_values=True):
        if 1 <= len(key) <= 32:
            candidates[f"?{key}="] += 1
            candidates[f"&{key}="] += 1
            candidates[f"{key}="] += 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dump", type=Path)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--top", type=int, default=40)
    parser.add_argument("--out", type=Path, default=Path("data/wiki/simplewiki-analysis.md"))
    args = parser.parse_args()

    schemes: collections.Counter[str] = collections.Counter()
    hosts: collections.Counter[str] = collections.Counter()
    tlds: collections.Counter[str] = collections.Counter()
    chars: collections.Counter[str] = collections.Counter()
    path_segments: collections.Counter[str] = collections.Counter()
    query_keys: collections.Counter[str] = collections.Counter()
    candidates: collections.Counter[str] = collections.Counter()
    lengths: list[int] = []

    total = 0
    for url in iter_urls(args.dump):
        total += 1
        if args.limit and total > args.limit:
            total -= 1
            break

        body = compression_body(url)
        split = urlsplit(url)
        schemes[split.scheme] += 1
        if split.hostname:
            hosts[split.hostname] += 1
            tlds[split.hostname.rsplit(".", 1)[-1]] += 1
        chars.update(body)
        lengths.append(len(body))

        for segment in split.path.split("/"):
            if segment:
                path_segments[segment] += 1
        for key, _ in parse_qsl(split.query, keep_blank_values=True):
            if key:
                query_keys[key] += 1
        add_candidates(body, candidates)

    def top_counter(counter: collections.Counter[str], n: int = args.top) -> str:
        return "\n".join(f"| `{k}` | {v} |" for k, v in counter.most_common(n))

    scored = []
    for candidate, count in candidates.items():
        if count < 5 or len(candidate) < 2:
            continue
        saved_bits_each = literal_bits(candidate) - 6
        if saved_bits_each <= 0:
            continue
        scored.append((count * saved_bits_each, candidate, count, saved_bits_each, literal_bits(candidate)))
    scored.sort(reverse=True)

    sorted_lengths = sorted(lengths)
    def pct(p: float) -> int:
        if not sorted_lengths:
            return 0
        return sorted_lengths[min(len(sorted_lengths) - 1, int(len(sorted_lengths) * p))]

    report = [
        "# simplewiki externallinks analysis",
        "",
        f"URLs: {total}",
        f"Body length p50/p90/p99: {pct(0.50)} / {pct(0.90)} / {pct(0.99)}",
        "",
        "## Schemes",
        "| value | count |",
        "| --- | ---: |",
        top_counter(schemes, 10),
        "",
        "## Top hosts",
        "| value | count |",
        "| --- | ---: |",
        top_counter(hosts, 25),
        "",
        "## Top TLDs",
        "| value | count |",
        "| --- | ---: |",
        top_counter(tlds, 25),
        "",
        "## Top path segments",
        "| value | count |",
        "| --- | ---: |",
        top_counter(path_segments, 40),
        "",
        "## Top query keys",
        "| value | count |",
        "| --- | ---: |",
        top_counter(query_keys, 40),
        "",
        "## Top candidate dictionary entries by estimated bit savings",
        "| candidate | count | saved bits/use | total score |",
        "| --- | ---: | ---: | ---: |",
    ]
    report.extend(f"| `{candidate}` | {count} | {saved_each} | {score} |" for score, candidate, count, saved_each, _ in scored[: args.top])
    report.extend([
        "",
        "## Top body characters",
        "| char | count |",
        "| --- | ---: |",
    ])
    report.extend(f"| `{repr(char)[1:-1]}` | {count} |" for char, count in chars.most_common(80))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(report) + "\n", encoding="utf-8")
    print(f"wrote {args.out} ({total} URLs)")


if __name__ == "__main__":
    main()
