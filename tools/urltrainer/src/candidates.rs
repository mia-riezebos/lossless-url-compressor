use crate::config::MAX_KEY_LEN;
use crate::stats::literal_bits;
use std::collections::HashMap;

const DOMAIN_SUFFIXES: &[&str] = &[
    "com", "org", "net", "gov", "edu", "co", "ac", "uk", "au", "jp", "de", "fr", "ca", "us", "mil",
    "info", "io", "tv", "ie", "nz", "nl", "se", "ru", "it", "in", "br", "cn", "es", "eu", "za",
    "ai", "dev", "app", "xyz", "me", "cloud", "online", "site", "shop",
];

const GENERIC_HOST_LABELS: &[&str] = &[
    "www",
    "m",
    "mobile",
    "api",
    "docs",
    "news",
    "books",
    "maps",
    "search",
    "support",
    "help",
    "blog",
    "cdn",
    "static",
    "assets",
    "images",
    "img",
    "data",
    "download",
    "downloads",
    "ftp",
    "mail",
    "media",
    "video",
    "shop",
    "store",
    "admin",
    "login",
    "auth",
    "status",
    "developer",
    "developers",
];

const GENERIC_PATH_WORDS: &[&str] = &[
    "api",
    "v1",
    "v2",
    "v3",
    "wp-content",
    "wp-admin",
    "content",
    "assets",
    "static",
    "images",
    "img",
    "media",
    "files",
    "download",
    "downloads",
    "news",
    "article",
    "articles",
    "blog",
    "posts",
    "post",
    "archive",
    "archives",
    "search",
    "results",
    "page",
    "pages",
    "watch",
    "video",
    "videos",
    "wiki",
    "index.php",
    "cgi-bin",
    "login",
    "auth",
    "oauth",
    "products",
    "product",
    "category",
    "categories",
    "docs",
    "documentation",
    "help",
    "support",
    "about",
    "tags",
    "tag",
    "reviews",
    "review",
    "html",
    "pdf",
    "en",
    "es",
    "de",
    "fr",
    "it",
    "nl",
    "ru",
    "ja",
    "zh",
    "ko",
    "pt",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RejectionReason {
    TooLong,
    NonAscii,
    NoSavings,
    ExactDomain,
    HashLike,
    PercentBlob,
    OverSpecificPath,
    LowSignal,
}

impl RejectionReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TooLong => "too-long",
            Self::NonAscii => "non-ascii",
            Self::NoSavings => "no-savings",
            Self::ExactDomain => "exact-domain",
            Self::HashLike => "hash-like",
            Self::PercentBlob => "percent-blob",
            Self::OverSpecificPath => "over-specific-path",
            Self::LowSignal => "low-signal-shape",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct RejectedCandidates {
    pub counts: HashMap<String, u64>,
    pub reasons: HashMap<String, RejectionReason>,
}

impl RejectedCandidates {
    pub fn bump(&mut self, candidate: &str, reason: RejectionReason) {
        *self.counts.entry(candidate.to_string()).or_default() += 1;
        self.reasons.entry(candidate.to_string()).or_insert(reason);
    }

    pub fn merge(&mut self, other: RejectedCandidates) {
        for (candidate, count) in other.counts {
            *self.counts.entry(candidate).or_default() += count;
        }
        for (candidate, reason) in other.reasons {
            self.reasons.entry(candidate).or_insert(reason);
        }
    }
}

pub fn candidate_rejection_reason(
    candidate: &str,
    token_cost_bits: usize,
) -> Option<RejectionReason> {
    if candidate.is_empty() {
        return Some(RejectionReason::LowSignal);
    }
    if candidate.len() > MAX_KEY_LEN {
        return Some(RejectionReason::TooLong);
    }
    if !candidate.is_ascii() {
        return Some(RejectionReason::NonAscii);
    }
    if literal_bits(candidate) <= token_cost_bits {
        return Some(RejectionReason::NoSavings);
    }
    if is_exact_registered_domain_pattern(candidate) {
        return Some(RejectionReason::ExactDomain);
    }
    if is_hash_like(candidate) {
        return Some(RejectionReason::HashLike);
    }
    if is_percent_blob(candidate) {
        return Some(RejectionReason::PercentBlob);
    }
    if is_over_specific_path_group(candidate) {
        return Some(RejectionReason::OverSpecificPath);
    }
    if is_low_signal_shape(candidate) {
        return Some(RejectionReason::LowSignal);
    }
    None
}

pub fn is_exact_registered_domain_pattern(candidate: &str) -> bool {
    let stripped = candidate
        .trim_matches('/')
        .trim_end_matches(['?', '#', ':'])
        .trim_start_matches('.');
    let labels: Vec<&str> = stripped
        .split('.')
        .filter(|label| !label.is_empty())
        .collect();
    if labels.len() < 2 {
        return false;
    }

    let suffix_len = public_suffix_len(&labels);
    let Some(registrable_index) = labels.len().checked_sub(suffix_len + 1) else {
        return false;
    };
    if registrable_index >= labels.len() {
        return false;
    }

    let suffix_labels = &labels[registrable_index + 1..];
    if !suffix_labels
        .iter()
        .all(|label| DOMAIN_SUFFIXES.contains(label))
    {
        return false;
    }

    let registered = labels[registrable_index];
    !GENERIC_HOST_LABELS.contains(&registered)
}

fn public_suffix_len(labels: &[&str]) -> usize {
    let last = labels.last().copied().unwrap_or("");
    let prev = labels
        .get(labels.len().wrapping_sub(2))
        .copied()
        .unwrap_or("");
    if last.len() == 2 && matches!(prev, "co" | "ac" | "gov" | "com" | "org" | "net") {
        2
    } else {
        1
    }
}

fn is_hash_like(candidate: &str) -> bool {
    let trimmed = candidate.trim_matches(['/', '?', '&', '=', '.', '-', '_']);
    if trimmed.len() < 12 {
        return false;
    }
    let hexish = trimmed
        .chars()
        .filter(|char| char.is_ascii_hexdigit())
        .count();
    let alnum = trimmed
        .chars()
        .filter(|char| char.is_ascii_alphanumeric())
        .count();
    hexish * 100 / trimmed.len() >= 80 || (alnum == trimmed.len() && vowel_count(trimmed) <= 1)
}

fn vowel_count(value: &str) -> usize {
    value
        .chars()
        .filter(|char| matches!(char.to_ascii_lowercase(), 'a' | 'e' | 'i' | 'o' | 'u'))
        .count()
}

fn is_percent_blob(candidate: &str) -> bool {
    if candidate.len() < 18 {
        return false;
    }
    let encoded_triplets = candidate.as_bytes().windows(3).filter(|window| {
        window[0] == b'%' && window[1].is_ascii_hexdigit() && window[2].is_ascii_hexdigit()
    });
    encoded_triplets.count() >= 4
}

fn is_over_specific_path_group(candidate: &str) -> bool {
    let pathish = candidate.starts_with('/') || candidate.contains('/');
    let segments: Vec<&str> = candidate
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.is_empty() {
        return false;
    }

    if segments
        .iter()
        .any(|segment| is_over_specific_segment(segment))
    {
        return true;
    }

    if !pathish || segments.len() < 2 {
        return false;
    }

    let generic = segments
        .iter()
        .filter(|segment| {
            GENERIC_PATH_WORDS.contains(segment)
                || segment.chars().all(|char| char.is_ascii_digit())
        })
        .count();
    generic + 1 < segments.len()
}

fn is_over_specific_segment(segment: &str) -> bool {
    if GENERIC_PATH_WORDS.contains(&segment) || segment.chars().all(|char| char.is_ascii_digit()) {
        return false;
    }
    if segment.len() > 48 {
        return true;
    }
    let uppercase = segment
        .chars()
        .filter(|char| char.is_ascii_uppercase())
        .count();
    let punctuation = segment
        .chars()
        .filter(|char| !char.is_ascii_alphanumeric() && !matches!(char, '-' | '_' | '.'))
        .count();
    segment.len() >= 16 && (uppercase >= 2 || punctuation > 0)
}

fn is_low_signal_shape(candidate: &str) -> bool {
    if candidate.len() == 1 {
        return true;
    }
    let has_boundary = candidate.contains(['/', '?', '&', '=', '.', ':']);
    let alpha = candidate
        .chars()
        .filter(|char| char.is_ascii_alphabetic())
        .count();
    let digit = candidate
        .chars()
        .filter(|char| char.is_ascii_digit())
        .count();
    !has_boundary && candidate.len() <= 3 && alpha + digit == candidate.len()
}

#[cfg(test)]
mod tests {
    use super::{candidate_rejection_reason, RejectionReason};

    #[test]
    fn rejects_exact_registered_domains() {
        assert_eq!(
            candidate_rejection_reason("example.com", 12),
            Some(RejectionReason::ExactDomain)
        );
        assert_eq!(candidate_rejection_reason(".com/", 12), None);
    }

    #[test]
    fn rejects_hashes_and_percent_blobs() {
        assert_eq!(
            candidate_rejection_reason("/a94a8fe5ccb19ba61c4c", 12),
            Some(RejectionReason::HashLike)
        );
        assert_eq!(
            candidate_rejection_reason("/%5Bfoo%5D%5Bbar%5D", 12),
            Some(RejectionReason::PercentBlob)
        );
    }

    #[test]
    fn rejects_site_specific_path_segments() {
        assert_eq!(
            candidate_rejection_reason("/CreateIssueDetails!init.jspa", 12),
            Some(RejectionReason::OverSpecificPath)
        );
        assert_eq!(candidate_rejection_reason("/wp-content/", 12), None);
    }
}
