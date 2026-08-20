#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

destination="${1:-/mnt/media/mia/commoncrawl/messaging-links}"
manifest="${2:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../data" && pwd)/messaging-link-sources.json}"

for tool in curl jq sha256sum md5sum stat; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s\n' "$tool" >&2
    exit 127
  fi
done

mkdir -p "$destination/logs"
cp -f -- "$manifest" "$destination/source-manifest.json"
status_path="$destination/download-status.json"
hashes_path="$destination/downloaded-sha256.txt"
printf '%s\n' "$$" > "$destination/download.pid"

write_status() {
  local state="$1"
  local name="$2"
  local filename="$3"
  local bytes_on_disk="$4"
  local expected_bytes="$5"
  local message="${6:-}"
  local temporary="$status_path.$$.tmp"

  jq -n \
    --arg updated_at "$(date --utc --iso-8601=seconds)" \
    --arg state "$state" \
    --arg current_item "$name" \
    --arg current_filename "$filename" \
    --argjson bytes_on_disk "$bytes_on_disk" \
    --argjson expected_bytes "$expected_bytes" \
    --arg message "$message" \
    '{updated_at:$updated_at,state:$state,current_item:$current_item,current_filename:$current_filename,bytes_on_disk:$bytes_on_disk,expected_bytes:$expected_bytes,message:$message}' \
    > "$temporary"
  mv -f -- "$temporary" "$status_path"
}

verify_hash() {
  local path="$1"
  local algorithm="$2"
  local expected="$3"
  local actual

  if [[ -z "$expected" ]]; then
    return 0
  fi

  case "${algorithm^^}" in
    SHA256) actual="$(sha256sum -- "$path" | cut -d' ' -f1)" ;;
    MD5) actual="$(md5sum -- "$path" | cut -d' ' -f1)" ;;
    *) printf 'Unsupported hash algorithm: %s\n' "$algorithm" >&2; return 2 ;;
  esac
  [[ "${actual,,}" == "${expected,,}" ]]
}

while IFS= read -r item; do
  name="$(jq -r '.name' <<<"$item")"
  relative_directory="$(jq -r '.directory' <<<"$item")"
  filename="$(jq -r '.filename' <<<"$item")"
  url="$(jq -r '.url' <<<"$item")"
  expected_bytes="$(jq -r 'if has("bytes") then (.bytes|tostring) else "null" end' <<<"$item")"
  hash_algorithm="$(jq -r '.hash_algorithm // ""' <<<"$item")"
  expected_hash="$(jq -r '.hash // ""' <<<"$item")"

  directory="$destination/$relative_directory"
  target="$directory/$filename"
  partial="$target.part"
  mkdir -p "$directory"

  if [[ -f "$target" ]]; then
    existing_bytes="$(stat -c '%s' -- "$target")"
    if { [[ "$expected_bytes" == "null" ]] || [[ "$existing_bytes" == "$expected_bytes" ]]; } && verify_hash "$target" "$hash_algorithm" "$expected_hash"; then
      write_status skipped "$name" "$filename" "$existing_bytes" "$expected_bytes" 'Already downloaded and verified.'
      continue
    fi
    printf 'Existing file failed verification: %s\n' "$target" >&2
    exit 1
  fi

  if [[ -f "$partial" && "$expected_bytes" != "null" && -n "$expected_hash" ]]; then
    partial_bytes="$(stat -c '%s' -- "$partial")"
    if [[ "$partial_bytes" == "$expected_bytes" ]] && verify_hash "$partial" "$hash_algorithm" "$expected_hash"; then
      mv -- "$partial" "$target"
      sha256sum -- "$target" >> "$hashes_path"
      write_status completed-item "$name" "$filename" "$partial_bytes" "$expected_bytes" 'Verified an already-complete partial download.'
      continue
    fi
  fi

  partial_bytes=0
  [[ -f "$partial" ]] && partial_bytes="$(stat -c '%s' -- "$partial")"
  write_status downloading "$name" "$filename" "$partial_bytes" "$expected_bytes"

  curl \
    --fail \
    --location \
    --retry 20 \
    --retry-delay 5 \
    --retry-all-errors \
    --connect-timeout 30 \
    --speed-time 180 \
    --speed-limit 1024 \
    --continue-at - \
    --output "$partial" \
    "$url"

  downloaded_bytes="$(stat -c '%s' -- "$partial")"
  if [[ "$expected_bytes" != "null" && "$downloaded_bytes" != "$expected_bytes" ]]; then
    write_status failed "$name" "$filename" "$downloaded_bytes" "$expected_bytes" 'Downloaded size does not match manifest.'
    printf 'Size mismatch for %s: got %s, expected %s\n' "$name" "$downloaded_bytes" "$expected_bytes" >&2
    exit 1
  fi
  if ! verify_hash "$partial" "$hash_algorithm" "$expected_hash"; then
    write_status failed "$name" "$filename" "$downloaded_bytes" "$expected_bytes" 'Checksum mismatch.'
    printf 'Checksum mismatch for %s\n' "$name" >&2
    exit 1
  fi

  mv -- "$partial" "$target"
  sha256sum -- "$target" >> "$hashes_path"
  write_status completed-item "$name" "$filename" "$downloaded_bytes" "$expected_bytes"
done < <(jq -c '.items[]' "$manifest")

jq -n \
  --arg updated_at "$(date --utc --iso-8601=seconds)" \
  '{updated_at:$updated_at,state:"complete",current_item:null,current_filename:null,bytes_on_disk:0,expected_bytes:null,message:"All sources downloaded and verified."}' \
  > "$status_path.$$.tmp"
mv -f -- "$status_path.$$.tmp" "$status_path"
