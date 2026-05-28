#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import re
from pathlib import Path

SPECIAL_SYMBOLS = 5  # ascii, number, ref, extended-dict, end
MAX_SYMBOLS = 64
MAX_EXTENDED = 64
DOMAIN_SUFFIXES = {"com", "org", "net", "gov", "edu", "co", "ac", "uk", "au", "jp", "de", "fr", "ca", "us", "mil", "info", "io", "tv", "ie", "nz", "nl", "se", "ru", "it", "in", "br", "cn", "es", "eu", "za"}
GENERIC_HOST_LABELS = {"www", "m", "mobile", "api", "docs", "news", "books", "maps", "search", "support", "help", "blog", "cdn", "static", "assets", "images", "data", "download", "downloads", "ftp", "mail"}
GENERIC_MULTI_SEGMENT_WORDS = {"news", "search", "article", "articles", "index.php", "cgi-bin", "books", "archive", "archives", "story", "stories", "content", "view", "page", "pages", "watch", "wiki", "images", "files", "sports", "music", "reviews", "about", "data", "results", "html", "pdf"}

CHAR_ROW = re.compile(r"\| `(.+)` \| (\d+) \|")
DICT_ROW = re.compile(r"\| `(.+)` \| (\d+) \| (\d+) \| (\d+) \|")
SELECTED_ROW = re.compile(r"\| `(.+)` \| (\d+) \| (-?\d+) \| ([\d.]+) \| (\d+) \| ([\d.]+) \|")


def unescape_table_value(value: str) -> str:
    try:
        return ast.literal_eval(f"'{value}'")
    except Exception:
        return value


def parse_section(markdown: str, heading: str) -> str:
    marker = f"## {heading}"
    start = markdown.index(marker) + len(marker)
    next_heading = markdown.find("\n## ", start)
    return markdown[start:] if next_heading == -1 else markdown[start:next_heading]


def parse_chars(markdown: str) -> list[str]:
    section = parse_section(markdown, "Top body characters")
    chars: list[str] = []

    for raw, _ in CHAR_ROW.findall(section):
        char = unescape_table_value(raw)
        if len(char) == 1 and ord(char) <= 0x7f and char != "`" and char not in chars:
            chars.append(char)

    return chars


def parse_dictionary(markdown: str) -> list[str]:
    entries = parse_selected_dictionary(markdown)
    if entries:
        return entries

    section = parse_section(markdown, "Top candidate dictionary entries")
    entries = []

    for raw, *_ in DICT_ROW.findall(section):
        entry = unescape_table_value(raw)
        if is_usable_dictionary_entry(entry, entries):
            entries.append(entry)

    return entries


def parse_selected_dictionary(markdown: str) -> list[str]:
    try:
        section = parse_section(markdown, "Selected dictionary entries")
    except ValueError:
        return []

    entries: list[str] = []
    for raw, *_ in SELECTED_ROW.findall(section):
        entry = unescape_table_value(raw)
        if is_usable_dictionary_entry(entry, entries):
            entries.append(entry)
    return entries


def is_usable_dictionary_entry(entry: str, existing: list[str]) -> bool:
    return bool(
        entry
        and all(ord(char) <= 0x7f for char in entry)
        and not is_exact_registered_domain_pattern(entry)
        and not is_over_specific_path_group(entry)
        and entry not in existing
    )


def is_over_specific_path_group(entry: str) -> bool:
    if not entry.startswith("/"):
        return False

    segments = [segment for segment in entry.strip("/").split("/") if segment]
    if len(segments) < 2:
        return False

    generic_count = sum(segment in GENERIC_MULTI_SEGMENT_WORDS for segment in segments)
    numeric_count = sum(segment.isdigit() for segment in segments)
    return generic_count + numeric_count < len(segments)


def is_exact_registered_domain_pattern(entry: str) -> bool:
    stripped = entry.strip("/")
    if stripped.startswith("."):
        stripped = stripped[1:]

    labels = stripped.split(".")
    if len(labels) < 2 or any(not label for label in labels):
        return False

    suffix_len = 2 if len(labels) >= 3 and labels[-2] in {"co", "ac", "gov", "com", "org", "net"} and len(labels[-1]) == 2 else 1
    registrable_index = len(labels) - suffix_len - 1
    if registrable_index < 0:
        return False

    prefix_labels = labels[:registrable_index]
    suffix_labels = labels[registrable_index + 1:]
    if not all(label in DOMAIN_SUFFIXES for label in suffix_labels):
        return False

    registered = labels[registrable_index]
    return registered not in GENERIC_HOST_LABELS and bool(prefix_labels or suffix_labels)


def ts_string(value: str) -> str:
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("analysis", type=Path)
    parser.add_argument("--out", type=Path, default=Path("src/model.ts"))
    parser.add_argument("--literal-count", type=int, default=48)
    args = parser.parse_args()

    markdown = args.analysis.read_text(encoding="utf-8")
    literal_chars = parse_chars(markdown)
    dictionary = parse_dictionary(markdown)

    literal_count = min(args.literal_count, len(literal_chars), MAX_SYMBOLS - SPECIAL_SYMBOLS)
    primary_count = MAX_SYMBOLS - SPECIAL_SYMBOLS - literal_count
    primary = dictionary[:primary_count]
    extended = dictionary[primary_count:primary_count + MAX_EXTENDED]
    literal_alphabet = "".join(literal_chars[:literal_count])

    content = f'''// Generated by scripts/write-trained-model.py from {args.analysis}.
// Full churn is expected between codec versions; do not preserve payload compatibility.

export const LITERAL_ALPHABET = {ts_string(literal_alphabet)};

export const PRIMARY_DICTIONARY = [
{chr(10).join(f"  {ts_string(entry)}," for entry in primary)}
] as const;

export const EXTENDED_DICTIONARY = [
{chr(10).join(f"  {ts_string(entry)}," for entry in extended)}
] as const;

export const DICTIONARY = [...PRIMARY_DICTIONARY, ...EXTENDED_DICTIONARY] as const;

export const ASCII_SYMBOL = LITERAL_ALPHABET.length + PRIMARY_DICTIONARY.length;
export const NUMBER_SYMBOL = ASCII_SYMBOL + 1;
export const REF_SYMBOL = NUMBER_SYMBOL + 1;
export const EXT_DICT_SYMBOL = REF_SYMBOL + 1;
export const END_SYMBOL = EXT_DICT_SYMBOL + 1;
export const SYMBOL_COUNT = END_SYMBOL + 1;

if (SYMBOL_COUNT > 64) {{
  throw new Error(`Model has ${{SYMBOL_COUNT}} symbols; packed MVP supports at most 64`);
}}

if (EXTENDED_DICTIONARY.length > 64) {{
  throw new Error("Extended dictionary supports at most 64 entries in the MVP");
}}

export const MIN_REF_LENGTH = 4;
export const MAX_REF_LENGTH = MIN_REF_LENGTH + 63;
export const MAX_REF_OFFSET = 4095;
export const MIN_NUMBER_LENGTH = 4;
export const MAX_NUMBER_LENGTH = 64;

export function literalSymbol(char: string): number | undefined {{
  const index = LITERAL_ALPHABET.indexOf(char);
  return index === -1 ? undefined : index;
}}

export function dictionarySymbol(id: number): number {{
  if (id < PRIMARY_DICTIONARY.length) return LITERAL_ALPHABET.length + id;
  return EXT_DICT_SYMBOL;
}}

export function primaryDictionaryValue(symbol: number): string | undefined {{
  const index = symbol - LITERAL_ALPHABET.length;
  return index < 0 ? undefined : PRIMARY_DICTIONARY[index];
}}

export function extendedDictionaryValue(index: number): string | undefined {{
  return EXTENDED_DICTIONARY[index];
}}

export function extendedDictionaryIndex(id: number): number {{
  return id - PRIMARY_DICTIONARY.length;
}}

export function isExtendedDictionaryId(id: number): boolean {{
  return id >= PRIMARY_DICTIONARY.length;
}}

export function decimalBitWidth(length: number): number {{
  if (!Number.isInteger(length) || length < 1 || length > MAX_NUMBER_LENGTH) {{
    throw new Error(`Invalid decimal length: ${{length}}`);
  }}

  return Math.ceil(length * Math.log2(10));
}}
'''

    args.out.write_text(content, encoding="utf-8")
    print(f"wrote {args.out}: literals={literal_count}, primary={len(primary)}, extended={len(extended)}")


if __name__ == "__main__":
    main()
