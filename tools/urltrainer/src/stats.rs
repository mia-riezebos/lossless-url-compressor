use crate::config::{COMMON_LITERAL_ALPHABET, LENGTH_BUCKETS, MAX_KEY_LEN};
use crate::counter::{bump, merge_counter, prune};
use crate::url_parts::{compression_body, parse_url_parts, public_suffix_len};
use std::collections::HashMap;

#[derive(Default)]
pub struct Stats {
    pub seen: u64,
    pub sampled: u64,
    pub schemes: HashMap<String, u64>,
    pub tlds: HashMap<String, u64>,
    pub path_segments: HashMap<String, u64>,
    pub query_keys: HashMap<String, u64>,
    pub candidates: HashMap<String, u64>,
    pub chars: HashMap<char, u64>,
    pub lengths: Vec<u64>,
}

impl Stats {
    pub fn new() -> Self {
        Self {
            lengths: vec![0; LENGTH_BUCKETS],
            ..Self::default()
        }
    }

    pub fn merge(&mut self, mut other: Stats) {
        self.seen += other.seen;
        self.sampled += other.sampled;
        merge_counter(&mut self.schemes, other.schemes);
        merge_counter(&mut self.tlds, other.tlds);
        merge_counter(&mut self.path_segments, other.path_segments);
        merge_counter(&mut self.query_keys, other.query_keys);
        merge_counter(&mut self.candidates, other.candidates);

        for (char, count) in other.chars.drain() {
            *self.chars.entry(char).or_default() += count;
        }
        for (index, count) in other.lengths.into_iter().enumerate() {
            self.lengths[index] += count;
        }
        prune(&mut self.candidates);
    }

    pub fn add_url(&mut self, url: &str) {
        let body = compression_body(url);
        for char in body.chars() {
            *self.chars.entry(char).or_default() += 1;
        }
        self.lengths[body.len().min(LENGTH_BUCKETS - 1)] += 1;

        let parts = parse_url_parts(url);
        bump(&mut self.schemes, parts.scheme, MAX_KEY_LEN);
        let labels: Vec<&str> = parts
            .host
            .split('.')
            .filter(|label| !label.is_empty())
            .collect();
        if let Some(tld) = labels.last() {
            bump(&mut self.tlds, tld, MAX_KEY_LEN);
        }

        self.add_host_shape(&labels, parts.path.starts_with('/'));
        self.add_path(parts.path);
        self.add_query(parts.query);
    }

    fn add_host_shape(&mut self, labels: &[&str], has_path: bool) {
        let suffix_len = public_suffix_len(labels);
        if suffix_len > 0 && labels.len() >= suffix_len {
            for size in 1..=suffix_len.min(3) {
                let suffix = labels[labels.len() - size..].join(".");
                bump(&mut self.candidates, &format!(".{suffix}"), MAX_KEY_LEN);
                if has_path {
                    bump(&mut self.candidates, &format!(".{suffix}/"), MAX_KEY_LEN);
                }
            }
        }

        let registrable = labels.len().saturating_sub(suffix_len + 1);
        let subdomains = &labels[..registrable];
        for label in subdomains {
            bump(&mut self.candidates, &format!("{label}."), MAX_KEY_LEN);
        }
        for size in 2..=subdomains.len().min(4) {
            for start in 0..=subdomains.len() - size {
                bump(
                    &mut self.candidates,
                    &(subdomains[start..start + size].join(".") + "."),
                    MAX_KEY_LEN,
                );
            }
        }
    }

    fn add_path(&mut self, path: &str) {
        let segments: Vec<&str> = path
            .split('/')
            .filter(|segment| !segment.is_empty() && segment.len() <= MAX_KEY_LEN)
            .collect();

        for segment in &segments {
            bump(&mut self.path_segments, segment, MAX_KEY_LEN);
            bump(&mut self.candidates, segment, MAX_KEY_LEN);
            bump(&mut self.candidates, &format!("/{segment}"), MAX_KEY_LEN);
            bump(&mut self.candidates, &format!("/{segment}/"), MAX_KEY_LEN);
            if let Some(dot) = segment.rfind('.') {
                if dot > 0 && dot + 1 < segment.len() {
                    bump(&mut self.candidates, &segment[dot..], MAX_KEY_LEN);
                }
            }
        }

        for size in 2..=segments.len().min(5) {
            for start in 0..=segments.len() - size {
                let phrase = "/".to_string() + &segments[start..start + size].join("/");
                bump(&mut self.candidates, &phrase, MAX_KEY_LEN);
                bump(&mut self.candidates, &(phrase + "/"), MAX_KEY_LEN);
            }
        }
    }

    fn add_query(&mut self, query: &str) {
        let keys: Vec<&str> = query
            .split('&')
            .filter_map(|part| part.split_once('=').map(|(key, _)| key))
            .filter(|key| !key.is_empty() && key.len() <= MAX_KEY_LEN)
            .collect();

        for key in &keys {
            bump(&mut self.query_keys, key, MAX_KEY_LEN);
            bump(&mut self.candidates, &format!("?{key}="), MAX_KEY_LEN);
            bump(&mut self.candidates, &format!("&{key}="), MAX_KEY_LEN);
            bump(&mut self.candidates, &format!("{key}="), MAX_KEY_LEN);
        }

        for size in 2..=keys.len().min(4) {
            for start in 0..=keys.len() - size {
                bump(
                    &mut self.candidates,
                    &("?".to_string() + &keys[start..start + size].join("=&") + "="),
                    MAX_KEY_LEN,
                );
            }
        }
    }
}

pub fn literal_bits(text: &str) -> usize {
    text.chars()
        .map(|char| {
            if COMMON_LITERAL_ALPHABET.contains(char) {
                6
            } else {
                13
            }
        })
        .sum()
}

pub fn percentile(lengths: &[u64], p: f64) -> usize {
    let total: u64 = lengths.iter().sum();
    if total == 0 {
        return 0;
    }

    let target = (total as f64 * p) as u64;
    let mut seen = 0;
    for (length, count) in lengths.iter().enumerate() {
        seen += count;
        if seen >= target {
            return length;
        }
    }

    lengths.len() - 1
}

pub fn scored_candidates(
    counter: &HashMap<String, u64>,
    limit: usize,
) -> Vec<(String, u64, i64, i64)> {
    let mut scored: Vec<_> = counter
        .iter()
        .filter_map(|(candidate, count)| {
            let saved_each = literal_bits(candidate) as i64 - 12;
            (saved_each > 0).then(|| {
                (
                    candidate.clone(),
                    *count,
                    saved_each,
                    *count as i64 * saved_each,
                )
            })
        })
        .collect();
    scored.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| a.0.cmp(&b.0)));
    scored.truncate(limit);
    scored
}
