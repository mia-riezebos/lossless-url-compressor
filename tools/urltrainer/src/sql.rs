use crate::args::ReadOrder;
use flate2::read::MultiGzDecoder;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

pub fn read_insert_lines<F>(
    path: &Path,
    order: ReadOrder,
    chunk_mib: u64,
    handle: F,
) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
{
    match order {
        ReadOrder::Sequential => read_insert_lines_sequential(path, handle),
        ReadOrder::Interleaved => read_insert_lines_interleaved(path, chunk_mib, handle),
    }
}

fn read_insert_lines_sequential<F>(path: &Path, handle: F) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
{
    let file = File::open(path).map_err(|err| err.to_string())?;
    let reader: Box<dyn Read> = if path.extension().is_some_and(|ext| ext == "gz") {
        Box::new(MultiGzDecoder::new(file))
    } else {
        Box::new(file)
    };
    let buf = BufReader::with_capacity(8 * 1024 * 1024, reader);

    read_insert_lines_from_reader(buf, handle)
}

fn read_insert_lines_interleaved<F>(
    path: &Path,
    chunk_mib: u64,
    mut handle: F,
) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
{
    if path.extension().is_some_and(|ext| ext == "gz") {
        return Err("interleaved read order requires an uncompressed .sql file".to_string());
    }

    let file_size = std::fs::metadata(path)
        .map_err(|err| err.to_string())?
        .len();
    let chunk_size = chunk_mib.max(1) * 1024 * 1024;
    let chunk_count = file_size.div_ceil(chunk_size);
    let mut order = Vec::with_capacity(chunk_count as usize);
    push_binary_order(0, chunk_count, &mut order);

    for chunk_index in order {
        let start = chunk_index * chunk_size;
        let end = ((chunk_index + 1) * chunk_size).min(file_size);
        read_chunk_lines(path, start, end, &mut handle)?;
    }

    Ok(())
}

fn push_binary_order(start: u64, end: u64, out: &mut Vec<u64>) {
    if start >= end {
        return;
    }

    let mid = start + (end - start) / 2;
    out.push(mid);
    push_binary_order(start, mid, out);
    push_binary_order(mid + 1, end, out);
}

fn read_chunk_lines<F>(path: &Path, start: u64, end: u64, handle: &mut F) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
{
    let mut file = File::open(path).map_err(|err| err.to_string())?;
    file.seek(SeekFrom::Start(start))
        .map_err(|err| err.to_string())?;
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, file);

    if start != 0 {
        let mut discarded = Vec::new();
        reader
            .read_until(b'\n', &mut discarded)
            .map_err(|err| err.to_string())?;
    }

    loop {
        let line_start = reader.stream_position().map_err(|err| err.to_string())?;
        if line_start >= end {
            break;
        }

        let mut bytes = Vec::new();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        if bytes.starts_with(b"INSERT INTO") {
            handle(String::from_utf8_lossy(&bytes).into_owned())?;
        }
    }

    Ok(())
}

fn read_insert_lines_from_reader<F, R>(
    mut reader: BufReader<R>,
    mut handle: F,
) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
    R: Read,
{
    loop {
        let mut bytes = Vec::new();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }

        if bytes.starts_with(b"INSERT INTO") {
            handle(String::from_utf8_lossy(&bytes).into_owned())?;
        }
    }

    Ok(())
}

pub fn parse_insert_line(line: &str) -> Vec<(String, String)> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] != b'(' {
            index += 1;
            continue;
        }

        index += 1;
        if !skip_int_comma(bytes, &mut index) || !skip_int_comma(bytes, &mut index) {
            continue;
        }

        let Some(domain) = parse_sql_string(bytes, &mut index) else {
            continue;
        };
        if index >= bytes.len() || bytes[index] != b',' {
            continue;
        }
        index += 1;

        let Some(path) = parse_sql_string(bytes, &mut index) else {
            continue;
        };
        out.push((domain, path));
    }

    out
}

fn skip_int_comma(bytes: &[u8], index: &mut usize) -> bool {
    while *index < bytes.len() && bytes[*index].is_ascii_digit() {
        *index += 1;
    }

    if *index >= bytes.len() || bytes[*index] != b',' {
        return false;
    }

    *index += 1;
    true
}

fn parse_sql_string(bytes: &[u8], index: &mut usize) -> Option<String> {
    if *index >= bytes.len() || bytes[*index] != b'\'' {
        return None;
    }
    *index += 1;

    let mut out = Vec::new();
    while *index < bytes.len() {
        let byte = bytes[*index];
        *index += 1;

        if byte == b'\'' {
            return Some(String::from_utf8_lossy(&out).into_owned());
        }

        if byte == b'\\' && *index < bytes.len() {
            let escaped = bytes[*index];
            *index += 1;
            out.push(match escaped {
                b'0' => 0,
                b'b' => 8,
                b'n' => b'\n',
                b'r' => b'\r',
                b't' => b'\t',
                b'Z' => 0x1a,
                other => other,
            });
            continue;
        }

        out.push(byte);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{parse_insert_line, push_binary_order};

    #[test]
    fn parses_externallinks_insert_tuples() {
        let line = "INSERT INTO `externallinks` VALUES (7,19211,'http://be.fci.www.','/nomenclatures.asp?lang=en&sel=0'),(8,1,'http://org.example.www.','/a\\'b');";

        let rows = parse_insert_line(line);

        assert_eq!(
            rows[0],
            (
                "http://be.fci.www.".to_string(),
                "/nomenclatures.asp?lang=en&sel=0".to_string()
            )
        );
        assert_eq!(
            rows[1],
            ("http://org.example.www.".to_string(), "/a'b".to_string())
        );
    }

    #[test]
    fn binary_order_visits_middle_then_halves() {
        let mut order = Vec::new();
        push_binary_order(0, 8, &mut order);

        assert_eq!(order, vec![4, 2, 1, 0, 3, 6, 5, 7]);
    }
}
