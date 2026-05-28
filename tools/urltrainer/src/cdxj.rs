use flate2::read::MultiGzDecoder;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

pub fn read_cdxj_lines<F>(path: &Path, mut handle: F) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
{
    for shard in cdxj_inputs(path)? {
        read_cdxj_file(&shard, &mut handle)?;
    }
    Ok(())
}

fn cdxj_inputs(path: &Path) -> Result<Vec<PathBuf>, String> {
    if path.is_file() {
        return Ok(vec![path.to_path_buf()]);
    }
    if !path.is_dir() {
        return Err(format!("input path does not exist: {}", path.display()));
    }

    let mut inputs = Vec::new();
    for entry in fs::read_dir(path).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().is_some_and(|ext| ext == "tmp") {
            continue;
        }

        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with("cdx-") && (name.ends_with(".gz") || !name.contains('.')) {
            inputs.push(path);
        }
    }
    inputs.sort();
    Ok(inputs)
}

fn read_cdxj_file<F>(path: &Path, handle: &mut F) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
{
    eprintln!("reading {}", path.display());
    let file = File::open(path).map_err(|err| err.to_string())?;
    let reader: Box<dyn Read> = if path.extension().is_some_and(|ext| ext == "gz") {
        Box::new(MultiGzDecoder::new(file))
    } else {
        Box::new(file)
    };
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, reader);

    loop {
        let mut bytes = Vec::new();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        handle(String::from_utf8_lossy(&bytes).into_owned())?;
    }

    Ok(())
}

pub fn extract_url(line: &str) -> Option<String> {
    let json = line.splitn(3, ' ').nth(2)?.as_bytes();
    let key_index = find_json_key(json, b"url")?;
    let mut index = key_index + b"\"url\"".len();
    skip_json_ws(json, &mut index);
    if json.get(index) != Some(&b':') {
        return None;
    }
    index += 1;
    skip_json_ws(json, &mut index);
    parse_json_string(json, &mut index)
}

fn find_json_key(json: &[u8], key: &[u8]) -> Option<usize> {
    let needle_len = key.len() + 2;
    let mut index = 0;
    while index + needle_len <= json.len() {
        if json[index] == b'\"'
            && &json[index + 1..index + 1 + key.len()] == key
            && json[index + 1 + key.len()] == b'\"'
        {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn skip_json_ws(bytes: &[u8], index: &mut usize) {
    while matches!(bytes.get(*index), Some(b' ' | b'\n' | b'\r' | b'\t')) {
        *index += 1;
    }
}

fn parse_json_string(bytes: &[u8], index: &mut usize) -> Option<String> {
    if bytes.get(*index) != Some(&b'\"') {
        return None;
    }
    *index += 1;

    let mut out = String::new();
    while *index < bytes.len() {
        let byte = bytes[*index];
        *index += 1;

        match byte {
            b'\"' => return Some(out),
            b'\\' => out.push(parse_json_escape(bytes, index)?),
            byte if byte.is_ascii() => out.push(byte as char),
            _ => {
                let start = *index - 1;
                let tail = std::str::from_utf8(&bytes[start..]).ok()?;
                let mut chars = tail.chars();
                let ch = chars.next()?;
                out.push(ch);
                *index = start + ch.len_utf8();
            }
        }
    }

    None
}

fn parse_json_escape(bytes: &[u8], index: &mut usize) -> Option<char> {
    let escaped = *bytes.get(*index)?;
    *index += 1;
    match escaped {
        b'\"' => Some('\"'),
        b'\\' => Some('\\'),
        b'/' => Some('/'),
        b'b' => Some('\u{0008}'),
        b'f' => Some('\u{000c}'),
        b'n' => Some('\n'),
        b'r' => Some('\r'),
        b't' => Some('\t'),
        b'u' => parse_unicode_escape(bytes, index),
        _ => None,
    }
}

fn parse_unicode_escape(bytes: &[u8], index: &mut usize) -> Option<char> {
    if *index + 4 > bytes.len() {
        return None;
    }
    let hex = std::str::from_utf8(&bytes[*index..*index + 4]).ok()?;
    *index += 4;
    let value = u32::from_str_radix(hex, 16).ok()?;
    char::from_u32(value)
}

#[cfg(test)]
mod tests {
    use super::extract_url;

    #[test]
    fn extracts_url_from_cdxj_line() {
        let line = r#"com,example)/a 20260514113514 {"url": "https://example.com/a?b=c", "status": "200"}"#;

        assert_eq!(extract_url(line).unwrap(), "https://example.com/a?b=c");
    }

    #[test]
    fn unescapes_json_url() {
        let line = r#"com,example)/a 20260514113514 {"status":"200","url":"https:\/\/example.com\/a?q=\"x\"&u=\u2713"}"#;

        assert_eq!(
            extract_url(line).unwrap(),
            "https://example.com/a?q=\"x\"&u=✓"
        );
    }
}
