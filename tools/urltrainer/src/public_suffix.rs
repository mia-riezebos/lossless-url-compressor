use idna::domain_to_ascii;
use std::collections::HashSet;
use std::net::IpAddr;
use std::path::Path;
use std::str::FromStr;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomainIdentity {
    pub hostname: String,
    pub suffix: String,
    pub registrable_domain: String,
    pub has_www: bool,
}

#[derive(Clone, Debug, Default)]
pub struct PublicSuffixList {
    exact: HashSet<String>,
    wildcard: HashSet<String>,
    exception: HashSet<String>,
}

impl PublicSuffixList {
    pub fn from_path(path: &Path) -> Result<Self, String> {
        let contents = std::fs::read_to_string(path)
            .map_err(|err| format!("could not read {}: {err}", path.display()))?;
        Ok(Self::from_text(&contents))
    }

    pub fn from_text(contents: &str) -> Self {
        let mut list = Self::default();
        for raw_line in contents.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with("//") {
                continue;
            }

            let (target, rule) = if let Some(rule) = line.strip_prefix('!') {
                (&mut list.exception, rule)
            } else if let Some(rule) = line.strip_prefix("*.") {
                (&mut list.wildcard, rule)
            } else {
                (&mut list.exact, line)
            };
            if let Ok(ascii) = domain_to_ascii(rule) {
                target.insert(ascii.to_lowercase());
            }
        }
        list
    }

    pub fn identity(&self, raw_hostname: &str) -> Option<DomainIdentity> {
        let normalized = domain_to_ascii(raw_hostname).ok()?;
        let normalized = normalized.trim_end_matches('.').to_lowercase();
        if !is_valid_dns_hostname(&normalized) || IpAddr::from_str(&normalized).is_ok() {
            return None;
        }

        let has_www = normalized.starts_with("www.");
        let hostname = normalized.strip_prefix("www.").unwrap_or(&normalized);
        let suffix = self.public_suffix(hostname)?;
        let labels = hostname.split('.').collect::<Vec<_>>();
        let suffix_labels = suffix.split('.').count();
        if labels.len() <= suffix_labels {
            return None;
        }
        let registrable_domain = labels[labels.len() - suffix_labels - 1..].join(".");

        Some(DomainIdentity {
            hostname: hostname.to_string(),
            suffix,
            registrable_domain,
            has_www,
        })
    }

    fn public_suffix(&self, hostname: &str) -> Option<String> {
        let labels = hostname.split('.').collect::<Vec<_>>();
        if labels.is_empty() {
            return None;
        }

        let mut match_length = 1;
        for index in 0..labels.len() {
            let candidate = labels[index..].join(".");
            if self.exception.contains(&candidate) {
                return Some(labels[index + 1..].join("."));
            }
            if self.exact.contains(&candidate) {
                match_length = match_length.max(labels.len() - index);
            }
            if index > 0 && self.wildcard.contains(&candidate) {
                match_length = match_length.max(labels.len() - index + 1);
            }
        }
        Some(labels[labels.len() - match_length..].join("."))
    }
}

fn is_valid_dns_hostname(hostname: &str) -> bool {
    if hostname.is_empty() || hostname.len() > 253 {
        return false;
    }

    hostname.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && label
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

#[cfg(test)]
mod tests {
    use super::{is_valid_dns_hostname, PublicSuffixList};

    #[test]
    fn resolves_exact_wildcard_and_exception_rules() {
        let list = PublicSuffixList::from_text("com\nco.uk\n*.ck\n!www.ck\n");

        let uk = list.identity("www.news.example.co.uk").unwrap();
        assert_eq!(uk.hostname, "news.example.co.uk");
        assert_eq!(uk.suffix, "co.uk");
        assert_eq!(uk.registrable_domain, "example.co.uk");
        assert!(uk.has_www);

        let wildcard = list.identity("a.b.ck").unwrap();
        assert_eq!(wildcard.suffix, "b.ck");
        assert_eq!(wildcard.registrable_domain, "a.b.ck");

        let exception = list.identity("a.www.ck").unwrap();
        assert_eq!(exception.suffix, "ck");
        assert_eq!(exception.registrable_domain, "www.ck");
    }

    #[test]
    fn validates_dns_label_syntax_and_lengths() {
        for hostname in [
            "youtube.com",
            "foo-bar.example.co.uk",
            "xn--bcher-kva.example",
        ] {
            assert!(is_valid_dns_hostname(hostname), "rejected {hostname}");
        }

        for hostname in [
            "$2koutube.com",
            "${app_name}.herokuapp.com",
            "(.*)",
            "***********.com",
            "under_score.example.com",
            "-leading.example.com",
            "trailing-.example.com",
            "two..dots.example.com",
        ] {
            assert!(!is_valid_dns_hostname(hostname), "accepted {hostname}");
        }

        assert!(!is_valid_dns_hostname(&format!("{}.com", "a".repeat(64))));
        assert!(!is_valid_dns_hostname(&format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(62)
        )));
    }
}
