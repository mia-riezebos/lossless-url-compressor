use crate::candidates::{candidate_rejection_reason, RejectedCandidates};
use crate::config::{COMMON_LITERAL_ALPHABET, LENGTH_BUCKETS, MAX_COUNTER_KEYS, MAX_KEY_LEN};
use crate::corpus::{
    empty_class_counts, training_class_default_weights, ClassCounts, TrainingUrl,
    TRAINING_CLASS_COUNT, TRAINING_SIGNAL_COUNT,
};
use crate::counter::{bump_by, merge_counter, prune, prune_if_needed};
use crate::url_parts::{compression_body, parse_url_parts};
use std::collections::{HashMap, HashSet};

pub type SignalCounts = Vec<(u16, u64)>;

#[derive(Default)]
pub struct Stats {
    pub seen: u64,
    pub sampled: u64,
    pub weighted: u64,
    pub schemes: HashMap<String, u64>,
    pub tlds: HashMap<String, u64>,
    pub suffixes: HashMap<String, u64>,
    pub hosts: HashMap<String, u64>,
    pub source_sites: HashMap<String, u64>,
    pub suffix_class_counts: HashMap<String, ClassCounts>,
    pub host_class_counts: HashMap<String, ClassCounts>,
    pub source_class_counts: HashMap<String, ClassCounts>,
    pub class_totals: ClassCounts,
    pub signal_totals: Vec<u64>,
    pub scheme_signal_counts: HashMap<String, SignalCounts>,
    pub tld_signal_counts: HashMap<String, SignalCounts>,
    pub suffix_signal_counts: HashMap<String, SignalCounts>,
    pub host_signal_counts: HashMap<String, SignalCounts>,
    pub source_signal_counts: HashMap<String, SignalCounts>,
    pub path_signal_counts: HashMap<String, SignalCounts>,
    pub query_signal_counts: HashMap<String, SignalCounts>,
    pub candidate_signal_counts: HashMap<String, SignalCounts>,
    pub host_pattern_signal_counts: HashMap<String, SignalCounts>,
    pub char_signal_counts: HashMap<char, SignalCounts>,
    pub length_signal_counts: Vec<SignalCounts>,
    pub path_segments: HashMap<String, u64>,
    pub query_keys: HashMap<String, u64>,
    pub candidates: HashMap<String, u64>,
    pub candidate_class_counts: HashMap<String, ClassCounts>,
    pub rejected_candidates: RejectedCandidates,
    pub heldout_urls: Vec<(u64, TrainingUrl)>,
    pub chars: HashMap<char, u64>,
    pub lengths: Vec<u64>,
}

impl Stats {
    pub fn new() -> Self {
        Self {
            class_totals: empty_class_counts(),
            signal_totals: vec![0; TRAINING_SIGNAL_COUNT],
            lengths: vec![0; LENGTH_BUCKETS],
            length_signal_counts: vec![SignalCounts::new(); LENGTH_BUCKETS],
            ..Self::default()
        }
    }

    pub fn merge(&mut self, mut other: Stats) {
        self.seen += other.seen;
        self.sampled += other.sampled;
        self.weighted += other.weighted;
        merge_counter(&mut self.schemes, other.schemes);
        merge_counter(&mut self.tlds, other.tlds);
        merge_counter(&mut self.suffixes, other.suffixes);
        merge_counter(&mut self.hosts, other.hosts);
        merge_counter(&mut self.source_sites, other.source_sites);
        merge_class_counter(&mut self.suffix_class_counts, other.suffix_class_counts);
        merge_class_counter(&mut self.host_class_counts, other.host_class_counts);
        merge_class_counter(&mut self.source_class_counts, other.source_class_counts);
        for (target, value) in self.class_totals.iter_mut().zip(other.class_totals) {
            *target += value;
        }
        for (target, value) in self.signal_totals.iter_mut().zip(other.signal_totals) {
            *target += value;
        }
        merge_signal_counter(&mut self.scheme_signal_counts, other.scheme_signal_counts);
        merge_signal_counter(&mut self.tld_signal_counts, other.tld_signal_counts);
        merge_signal_counter(&mut self.suffix_signal_counts, other.suffix_signal_counts);
        merge_signal_counter(&mut self.host_signal_counts, other.host_signal_counts);
        merge_signal_counter(&mut self.source_signal_counts, other.source_signal_counts);
        merge_signal_counter(&mut self.path_signal_counts, other.path_signal_counts);
        merge_signal_counter(&mut self.query_signal_counts, other.query_signal_counts);
        merge_signal_counter(
            &mut self.candidate_signal_counts,
            other.candidate_signal_counts,
        );
        merge_signal_counter(
            &mut self.host_pattern_signal_counts,
            other.host_pattern_signal_counts,
        );
        merge_char_signal_counter(&mut self.char_signal_counts, other.char_signal_counts);
        merge_counter(&mut self.path_segments, other.path_segments);
        merge_counter(&mut self.query_keys, other.query_keys);
        merge_counter(&mut self.candidates, other.candidates);
        merge_class_counter(
            &mut self.candidate_class_counts,
            other.candidate_class_counts,
        );
        self.rejected_candidates.merge(other.rejected_candidates);
        self.heldout_urls.extend(other.heldout_urls);

        for (char, count) in other.chars.drain() {
            *self.chars.entry(char).or_default() += count;
        }
        for (index, count) in other.lengths.into_iter().enumerate() {
            self.lengths[index] += count;
        }
        for (index, counts) in other.length_signal_counts.into_iter().enumerate() {
            merge_signal_counts(&mut self.length_signal_counts[index], counts);
        }
        prune_if_needed(&mut self.candidates);
    }

    pub fn prune_to_limits(&mut self) {
        for counter in [
            &mut self.schemes,
            &mut self.tlds,
            &mut self.suffixes,
            &mut self.hosts,
            &mut self.source_sites,
            &mut self.path_segments,
            &mut self.query_keys,
            &mut self.candidates,
        ] {
            prune(counter);
        }
        for counter in [
            &mut self.suffix_class_counts,
            &mut self.host_class_counts,
            &mut self.source_class_counts,
            &mut self.candidate_class_counts,
        ] {
            prune_class_counter(counter);
        }
        for counter in [
            &mut self.scheme_signal_counts,
            &mut self.tld_signal_counts,
            &mut self.suffix_signal_counts,
            &mut self.host_signal_counts,
            &mut self.source_signal_counts,
            &mut self.path_signal_counts,
            &mut self.query_signal_counts,
            &mut self.candidate_signal_counts,
            &mut self.host_pattern_signal_counts,
        ] {
            prune_signal_counter(counter);
        }
    }

    pub fn add_url(
        &mut self,
        record: &TrainingUrl,
        collect_candidates: bool,
        token_cost_bits: usize,
    ) {
        self.add_header_url(record);

        let weight = record.analysis_weight;
        let body = compression_body(&record.url);
        let signal = record.training_signal_index();
        for char in body.chars() {
            bump_signal_char(&mut self.char_signal_counts, char, signal, 1);
        }
        bump_signal_counts(
            &mut self.length_signal_counts[body.len().min(LENGTH_BUCKETS - 1)],
            signal,
            1,
        );
        if weight > 0 {
            for char in body.chars() {
                *self.chars.entry(char).or_default() += weight;
            }
            self.lengths[body.len().min(LENGTH_BUCKETS - 1)] += weight;
        }

        let parts = parse_url_parts(&record.url);
        bump_signal(&mut self.scheme_signal_counts, parts.scheme, signal, 1);
        if weight > 0 {
            bump_by(&mut self.schemes, parts.scheme, MAX_KEY_LEN, weight);
        }
        let labels: Vec<&str> = parts
            .host
            .split('.')
            .filter(|label| !label.is_empty())
            .collect();
        if let Some(tld) = labels.last() {
            bump_signal(&mut self.tld_signal_counts, tld, signal, 1);
            if weight > 0 {
                bump_by(&mut self.tlds, tld, MAX_KEY_LEN, weight);
            }
        }

        if !collect_candidates {
            return;
        }

        // Host and suffix statistics are collected by `add_header_url`.  Do not also emit
        // them as generic payload-token candidates: a v2 header consumes that exact URL
        // position, and treating `.com/`, `.com`, or `www.` as payload terms double-counts
        // its saving.  Path/query extraction below remains intentionally independent, so a
        // literal domain-looking value genuinely occurring in a path or query can still win.
        self.add_path(parts.path, token_cost_bits, record);
        self.add_query(parts.query, token_cost_bits, record);
        self.add_host_patterns(parts.path, parts.query, token_cost_bits, record);
    }

    pub fn add_header_url(&mut self, record: &TrainingUrl) {
        let weight = record.analysis_weight;
        self.weighted += weight;
        self.class_totals[record.training_class_index()] += 1;
        self.signal_totals[record.training_signal_index()] += 1;
        bump_class(&mut self.suffix_class_counts, &record.suffix, record);
        bump_signal(
            &mut self.suffix_signal_counts,
            &record.suffix,
            record.training_signal_index(),
            1,
        );
        bump_class(
            &mut self.host_class_counts,
            &record.registrable_domain,
            record,
        );
        bump_signal(
            &mut self.host_signal_counts,
            &record.registrable_domain,
            record.training_signal_index(),
            1,
        );
        if let Some(source) = &record.source_registrable_domain {
            bump_class(&mut self.source_class_counts, source, record);
            bump_signal(
                &mut self.source_signal_counts,
                source,
                record.training_signal_index(),
                1,
            );
            if weight > 0 {
                bump_by(&mut self.source_sites, source, MAX_KEY_LEN, weight);
            }
        }
        if weight > 0 {
            bump_by(&mut self.suffixes, &record.suffix, MAX_KEY_LEN, weight);
            bump_by(
                &mut self.hosts,
                &record.registrable_domain,
                MAX_KEY_LEN,
                weight,
            );
        }
    }

    pub fn add_heldout_url(&mut self, record: TrainingUrl, key: u64, max_urls: usize) {
        self.heldout_urls.push((key, record));
        if self.heldout_urls.len() > max_urls.saturating_mul(2) {
            self.truncate_heldout_urls(max_urls);
        }
    }

    pub fn truncate_heldout_urls(&mut self, max_urls: usize) {
        if self.heldout_urls.len() <= max_urls {
            return;
        }
        let per_class = max_urls.div_ceil(TRAINING_CLASS_COUNT);
        self.heldout_urls
            .sort_by_key(|(key, record)| (record.training_class_index(), *key));
        let mut class_counts = [0usize; TRAINING_CLASS_COUNT];
        self.heldout_urls.retain(|(_, record)| {
            let count = &mut class_counts[record.training_class_index()];
            let keep = *count < per_class;
            *count += 1;
            keep
        });
        self.heldout_urls.sort_by_key(|(key, _)| *key);
    }

    fn add_path(&mut self, path: &str, token_cost_bits: usize, record: &TrainingUrl) {
        let segments: Vec<&str> = path
            .split('/')
            .filter(|segment| !segment.is_empty() && segment.len() <= MAX_KEY_LEN)
            .collect();

        for segment in &segments {
            bump_signal(
                &mut self.path_signal_counts,
                segment,
                record.training_signal_index(),
                1,
            );
            if record.analysis_weight > 0 {
                bump_by(
                    &mut self.path_segments,
                    segment,
                    MAX_KEY_LEN,
                    record.analysis_weight,
                );
            }
            self.bump_candidate(segment, token_cost_bits, record);
            self.bump_candidate(&format!("/{segment}"), token_cost_bits, record);
            self.bump_candidate(&format!("/{segment}/"), token_cost_bits, record);
            if let Some(dot) = segment.rfind('.') {
                if dot > 0 && dot + 1 < segment.len() {
                    self.bump_candidate(&segment[dot..], token_cost_bits, record);
                }
            }
        }

        for size in 2..=segments.len().min(5) {
            for start in 0..=segments.len() - size {
                let phrase = "/".to_string() + &segments[start..start + size].join("/");
                self.bump_candidate(&phrase, token_cost_bits, record);
                self.bump_candidate(&(phrase + "/"), token_cost_bits, record);
            }
        }
    }

    fn add_query(&mut self, query: &str, token_cost_bits: usize, record: &TrainingUrl) {
        let keys: Vec<&str> = query
            .split('&')
            .filter_map(|part| part.split_once('=').map(|(key, _)| key))
            .filter(|key| !key.is_empty() && key.len() <= MAX_KEY_LEN)
            .collect();

        for key in &keys {
            bump_signal(
                &mut self.query_signal_counts,
                key,
                record.training_signal_index(),
                1,
            );
            if record.analysis_weight > 0 {
                bump_by(
                    &mut self.query_keys,
                    key,
                    MAX_KEY_LEN,
                    record.analysis_weight,
                );
            }
            self.bump_candidate(&format!("?{key}="), token_cost_bits, record);
            self.bump_candidate(&format!("&{key}="), token_cost_bits, record);
            self.bump_candidate(&format!("{key}="), token_cost_bits, record);
        }

        for size in 2..=keys.len().min(4) {
            for start in 0..=keys.len() - size {
                self.bump_candidate(
                    &("?".to_string() + &keys[start..start + size].join("=&") + "="),
                    token_cost_bits,
                    record,
                );
            }
        }
    }

    fn add_host_patterns(
        &mut self,
        path: &str,
        query: &str,
        token_cost_bits: usize,
        record: &TrainingUrl,
    ) {
        let segments = path
            .split('/')
            .filter(|segment| !segment.is_empty() && segment.len() <= MAX_KEY_LEN)
            .collect::<Vec<_>>();
        let query_keys = query
            .split('&')
            .filter_map(|part| part.split_once('=').map(|(key, _)| key))
            .filter(|key| !key.is_empty() && key.len() <= MAX_KEY_LEN)
            .collect::<Vec<_>>();
        let mut patterns = HashSet::new();

        for size in 1..=segments.len().min(3) {
            for start in 0..=segments.len() - size {
                let term = format!("/{}/", segments[start..start + size].join("/"));
                let kind = match (start, size) {
                    (0, _) => "path-prefix",
                    (_, 1) => "path-segment",
                    _ => "path-sequence",
                };
                self.bump_host_pattern(&mut patterns, kind, &term, token_cost_bits, record);
            }
        }

        for (index, key) in query_keys.iter().enumerate() {
            let positioned = if index == 0 {
                format!("?{key}=")
            } else {
                format!("&{key}=")
            };
            self.bump_host_pattern(
                &mut patterns,
                if index == 0 {
                    "query-first"
                } else {
                    "query-later"
                },
                &positioned,
                token_cost_bits,
                record,
            );
            self.bump_host_pattern(
                &mut patterns,
                "query-key-anywhere",
                &format!("{key}="),
                token_cost_bits,
                record,
            );
        }

        if let Some(key) = query_keys.first() {
            let mut cross_boundary_terms = HashSet::new();
            if !path.is_empty() && segments.len() <= 2 {
                cross_boundary_terms.insert(("prefix-query", format!("{path}?{key}=")));
            }
            if let Some(last) = segments.last() {
                let suffix_term = format!("/{last}?{key}=");
                if !cross_boundary_terms
                    .iter()
                    .any(|(_, term)| term == &suffix_term)
                {
                    cross_boundary_terms.insert(("path-query", suffix_term));
                }
            }

            let mut candidate_terms = HashSet::new();
            for (kind, term) in cross_boundary_terms {
                if candidate_rejection_reason(&term, token_cost_bits).is_some() {
                    continue;
                }
                if candidate_terms.insert(term.clone()) {
                    self.bump_candidate(&term, token_cost_bits, record);
                }
                self.bump_host_pattern(&mut patterns, kind, &term, token_cost_bits, record);
            }
        }
    }

    fn bump_host_pattern(
        &mut self,
        seen: &mut HashSet<String>,
        kind: &str,
        term: &str,
        token_cost_bits: usize,
        record: &TrainingUrl,
    ) {
        if candidate_rejection_reason(term, token_cost_bits).is_some() {
            return;
        }
        let key = format!("{}\t{kind}\t{term}", record.registrable_domain);
        if seen.insert(key.clone()) {
            bump_signal(
                &mut self.host_pattern_signal_counts,
                &key,
                record.training_signal_index(),
                1,
            );
        }
    }

    fn bump_candidate(&mut self, candidate: &str, token_cost_bits: usize, record: &TrainingUrl) {
        if let Some(reason) = candidate_rejection_reason(candidate, token_cost_bits) {
            if record.analysis_weight > 0 {
                self.rejected_candidates
                    .bump_by(candidate, reason, record.analysis_weight);
            }
            return;
        }
        bump_class(&mut self.candidate_class_counts, candidate, record);
        bump_signal(
            &mut self.candidate_signal_counts,
            candidate,
            record.training_signal_index(),
            1,
        );
        if record.analysis_weight > 0 {
            bump_by(
                &mut self.candidates,
                candidate,
                MAX_KEY_LEN,
                record.analysis_weight,
            );
        }
    }
}

fn bump_class(counter: &mut HashMap<String, ClassCounts>, key: &str, record: &TrainingUrl) {
    if key.is_empty() || key.len() > 255 {
        return;
    }
    counter
        .entry(key.to_string())
        .or_insert_with(empty_class_counts)[record.training_class_index()] += 1;
    if counter.len() > MAX_COUNTER_KEYS * 2 {
        prune_class_counter(counter);
    }
}

fn bump_signal(counter: &mut HashMap<String, SignalCounts>, key: &str, signal: usize, amount: u64) {
    if key.is_empty() || key.len() > 255 {
        return;
    }
    bump_signal_counts(counter.entry(key.to_string()).or_default(), signal, amount);
    if counter.len() > MAX_COUNTER_KEYS * 2 {
        prune_signal_counter(counter);
    }
}

fn bump_signal_char(
    counter: &mut HashMap<char, SignalCounts>,
    key: char,
    signal: usize,
    amount: u64,
) {
    bump_signal_counts(counter.entry(key).or_default(), signal, amount);
}

fn bump_signal_counts(counts: &mut SignalCounts, signal: usize, amount: u64) {
    let signal = signal as u16;
    match counts.binary_search_by_key(&signal, |(index, _)| *index) {
        Ok(position) => counts[position].1 += amount,
        Err(position) => counts.insert(position, (signal, amount)),
    }
}

fn merge_signal_counts(target: &mut SignalCounts, source: SignalCounts) {
    for (signal, count) in source {
        bump_signal_counts(target, signal as usize, count);
    }
}

fn merge_signal_counter(
    target: &mut HashMap<String, SignalCounts>,
    source: HashMap<String, SignalCounts>,
) {
    for (key, counts) in source {
        merge_signal_counts(target.entry(key).or_default(), counts);
    }
    if target.len() > MAX_COUNTER_KEYS * 2 {
        prune_signal_counter(target);
    }
}

fn merge_char_signal_counter(
    target: &mut HashMap<char, SignalCounts>,
    source: HashMap<char, SignalCounts>,
) {
    for (key, counts) in source {
        merge_signal_counts(target.entry(key).or_default(), counts);
    }
}

fn prune_signal_counter(counter: &mut HashMap<String, SignalCounts>) {
    if counter.len() <= MAX_COUNTER_KEYS {
        return;
    }
    let default_weights = training_class_default_weights();
    let mut scored = counter
        .iter()
        .map(|(key, counts)| {
            let score = counts
                .iter()
                .map(|(signal, count)| {
                    count * default_weights[*signal as usize % TRAINING_CLASS_COUNT].max(1)
                })
                .sum::<u64>();
            (score, key)
        })
        .collect::<Vec<_>>();
    scored.sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    let keep = scored
        .into_iter()
        .take(MAX_COUNTER_KEYS)
        .map(|(_, key)| key.clone())
        .collect::<HashSet<_>>();
    counter.retain(|key, _| keep.contains(key));
}

fn merge_class_counter(
    target: &mut HashMap<String, ClassCounts>,
    source: HashMap<String, ClassCounts>,
) {
    for (key, counts) in source {
        let entry = target.entry(key).or_insert_with(empty_class_counts);
        for (target, value) in entry.iter_mut().zip(counts) {
            *target += value;
        }
    }
    if target.len() > MAX_COUNTER_KEYS * 2 {
        prune_class_counter(target);
    }
}

fn prune_class_counter(counter: &mut HashMap<String, ClassCounts>) {
    if counter.len() <= MAX_COUNTER_KEYS {
        return;
    }
    let default_weights = training_class_default_weights();
    let mut scored = counter
        .iter()
        .map(|(key, counts)| {
            let score = counts
                .iter()
                .zip(&default_weights)
                .map(|(count, weight)| count * (*weight).max(1))
                .sum::<u64>();
            (score, key)
        })
        .collect::<Vec<_>>();
    scored.sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    let keep = scored
        .into_iter()
        .take(MAX_COUNTER_KEYS)
        .map(|(_, key)| key.clone())
        .collect::<HashSet<_>>();
    counter.retain(|key, _| keep.contains(key));
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
    token_cost_bits: usize,
) -> Vec<(String, u64, i64, i64)> {
    let mut scored: Vec<_> = counter
        .iter()
        .filter_map(|(candidate, count)| {
            let saved_each = literal_bits(candidate) as i64 - token_cost_bits as i64;
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

#[cfg(test)]
mod tests {
    use super::Stats;
    use crate::corpus::{Dataset, LinkClass, LinkPresentation, TrainingUrl};

    #[test]
    fn preserves_raw_class_counts_alongside_default_weighted_counts() {
        let mut stats = Stats::new();
        for class in [LinkClass::SocialPost, LinkClass::Web] {
            let record = TrainingUrl {
                url: "https://example.com/article".to_string(),
                hostname: "example.com".to_string(),
                suffix: "com".to_string(),
                registrable_domain: "example.com".to_string(),
                has_www: false,
                dataset: Dataset::CommonCrawl,
                link_class: class,
                link_presentation: LinkPresentation::VisibleUrl,
                source_url: None,
                source_hostname: None,
                source_registrable_domain: None,
                display_text: None,
                link_href: None,
                analysis_weight: class.default_weight(),
            };
            stats.add_url(&record, false, 12);
        }

        assert_eq!(stats.weighted, 36);
        assert_eq!(stats.hosts["example.com"], 36);
        let common_crawl_social_signal = Dataset::CommonCrawl.index()
            * crate::corpus::TRAINING_CLASS_COUNT
            + crate::corpus::training_class_index(
                LinkClass::SocialPost,
                LinkPresentation::VisibleUrl,
            );
        assert_eq!(stats.signal_totals[common_crawl_social_signal], 1);
        assert_eq!(
            stats.host_signal_counts["example.com"]
                .iter()
                .find(|(signal, _)| *signal as usize == common_crawl_social_signal)
                .map(|(_, count)| *count),
            Some(1)
        );
        assert_eq!(
            stats.host_class_counts["example.com"][crate::corpus::training_class_index(
                LinkClass::SocialPost,
                LinkPresentation::VisibleUrl
            )],
            1
        );
        assert_eq!(
            stats.host_class_counts["example.com"]
                [crate::corpus::training_class_index(LinkClass::Web, LinkPresentation::VisibleUrl)],
            1
        );
    }

    #[test]
    fn preserves_reweightable_path_term_counts() {
        let mut stats = Stats::new();
        let mut record = TrainingUrl {
            url: "https://x.com/mia/status/123".to_string(),
            hostname: "x.com".to_string(),
            suffix: "com".to_string(),
            registrable_domain: "x.com".to_string(),
            has_www: false,
            dataset: Dataset::CommonCrawl,
            link_class: LinkClass::SocialPost,
            link_presentation: LinkPresentation::VisibleUrl,
            source_url: Some("https://reddit.com/r/example/comments/abc".to_string()),
            source_hostname: Some("reddit.com".to_string()),
            source_registrable_domain: Some("reddit.com".to_string()),
            display_text: Some("x.com/mia/status/123".to_string()),
            link_href: Some("https://x.com/mia/status/123".to_string()),
            analysis_weight: LinkClass::SocialPost.default_weight(),
        };
        stats.add_url(&record, true, 12);

        record.link_presentation = LinkPresentation::Masked;
        record.analysis_weight = 0;
        stats.add_url(&record, true, 12);

        let counts = &stats.candidate_class_counts["/status/"];
        assert_eq!(
            counts[crate::corpus::training_class_index(
                LinkClass::SocialPost,
                LinkPresentation::VisibleUrl
            )],
            1
        );
        assert_eq!(
            counts[crate::corpus::training_class_index(
                LinkClass::SocialPost,
                LinkPresentation::Masked
            )],
            1
        );
        assert_eq!(
            stats.candidates["/status/"],
            LinkClass::SocialPost.default_weight()
        );
        assert_eq!(
            stats.candidate_signal_counts["/status/"]
                .iter()
                .map(|(_, count)| count)
                .sum::<u64>(),
            2
        );
        assert_eq!(
            stats.host_pattern_signal_counts["x.com\tpath-segment\t/status/"]
                .iter()
                .map(|(_, count)| count)
                .sum::<u64>(),
            2
        );

        record.url = "https://youtube.com/watch?v=dQw4w9WgXcQ".to_string();
        record.hostname = "youtube.com".to_string();
        record.registrable_domain = "youtube.com".to_string();
        record.link_presentation = LinkPresentation::VisibleUrl;
        record.analysis_weight = LinkClass::SocialPost.default_weight();
        stats.add_url(&record, true, 12);

        assert_eq!(
            stats.candidate_signal_counts["/watch?v="]
                .iter()
                .map(|(_, count)| count)
                .sum::<u64>(),
            1
        );
        assert_eq!(
            stats.host_pattern_signal_counts["youtube.com\tprefix-query\t/watch?v="]
                .iter()
                .map(|(_, count)| count)
                .sum::<u64>(),
            1
        );

        record.url = "https://en.wikipedia.org/wiki/URL?oldid=123&redirect=no".to_string();
        record.hostname = "en.wikipedia.org".to_string();
        record.suffix = "org".to_string();
        record.registrable_domain = "wikipedia.org".to_string();
        stats.add_url(&record, true, 12);

        for key in [
            "wikipedia.org\tpath-prefix\t/wiki/",
            "wikipedia.org\tquery-first\t?oldid=",
            "wikipedia.org\tquery-key-anywhere\toldid=",
            "wikipedia.org\tquery-later\t&redirect=",
            "wikipedia.org\tquery-key-anywhere\tredirect=",
        ] {
            assert_eq!(
                stats.host_pattern_signal_counts[key]
                    .iter()
                    .map(|(_, count)| count)
                    .sum::<u64>(),
                1,
                "missing host pattern {key}"
            );
        }
    }
}
