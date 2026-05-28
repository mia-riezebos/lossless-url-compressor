pub struct UrlParts<'a> {
    pub scheme: &'a str,
    pub host: &'a str,
    pub path: &'a str,
    pub query: &'a str,
}

pub fn domain_index_to_url(domain_index: &str, path: &str) -> Option<String> {
    let (scheme, reversed_host) = domain_index.split_once("://")?;
    let labels: Vec<&str> = reversed_host
        .trim_end_matches('.')
        .split('.')
        .filter(|label| !label.is_empty())
        .collect();
    if labels.is_empty() {
        return None;
    }

    let host = labels
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(".")
        .to_lowercase();
    Some(format!("{}://{}{}", scheme.to_lowercase(), host, path))
}

pub fn compression_body(url: &str) -> &str {
    url.strip_prefix("https://").unwrap_or(url)
}

pub fn parse_url_parts(url: &str) -> UrlParts<'_> {
    let (scheme, rest) = split_once(url, "://").unwrap_or(("", url));
    let (host, tail) = split_host_tail(rest);
    let (path, query) = split_path_query(tail);

    UrlParts {
        scheme,
        host,
        path,
        query,
    }
}

pub fn public_suffix_len(labels: &[&str]) -> usize {
    if labels.is_empty() {
        return 0;
    }

    let last = labels[labels.len() - 1];
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

fn split_once<'a>(value: &'a str, needle: &str) -> Option<(&'a str, &'a str)> {
    let index = value.find(needle)?;
    Some((&value[..index], &value[index + needle.len()..]))
}

fn split_host_tail(rest: &str) -> (&str, &str) {
    let index = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    (&rest[..index], &rest[index..])
}

fn split_path_query(tail: &str) -> (&str, &str) {
    let fragment_index = tail.find('#').unwrap_or(tail.len());
    let visible = &tail[..fragment_index];

    if let Some(query_index) = visible.find('?') {
        (&visible[..query_index], &visible[query_index + 1..])
    } else {
        (visible, "")
    }
}

#[cfg(test)]
mod tests {
    use super::{domain_index_to_url, parse_url_parts};

    #[test]
    fn converts_wiki_domain_index_to_url() {
        assert_eq!(
            domain_index_to_url("http://com.example.www.", "/a").unwrap(),
            "http://www.example.com/a"
        );
    }

    #[test]
    fn splits_url_parts_without_url_parser() {
        let parts = parse_url_parts("http://www.example.com/a/b?c=d#frag");

        assert_eq!(parts.scheme, "http");
        assert_eq!(parts.host, "www.example.com");
        assert_eq!(parts.path, "/a/b");
        assert_eq!(parts.query, "c=d");
    }
}
