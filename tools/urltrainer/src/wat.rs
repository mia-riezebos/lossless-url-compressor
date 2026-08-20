use crate::corpus::{Dataset, LinkClass, LinkPresentation, TrainingUrl};
use crate::public_suffix::PublicSuffixList;
use flate2::read::MultiGzDecoder;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;
use url::Url;

const MAX_LINK_URL_LENGTH: usize = 16_384;
const MAX_ANCHORS_PER_PAGE: usize = 20_000;
const MAX_LINKS_PER_TARGET_DOMAIN_PER_PAGE: usize = 3;
const MAX_RETAINED_DISPLAY_TEXT_LENGTH: usize = 1_024;
const MAX_RETAINED_SOURCE_URL_LENGTH: usize = 4_096;
const WAT_OPEN_ATTEMPTS: usize = 5;

pub fn read_wat_urls<F>(
    path: &Path,
    threads: usize,
    suffixes: &PublicSuffixList,
    handle: F,
) -> Result<(), String>
where
    F: Fn(TrainingUrl) -> Result<(), String> + Sync,
{
    let inputs = wat_inputs(path)?;
    if inputs.is_empty() {
        return Err(format!(
            "no .warc.wat.gz files found under {}",
            path.display()
        ));
    }

    let worker_count = threads.max(1).min(inputs.len());
    let next = AtomicUsize::new(0);
    let completed = AtomicUsize::new(0);
    eprintln!(
        "streaming {} WAT files with {} readers",
        inputs.len(),
        worker_count
    );

    thread::scope(|scope| {
        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            workers.push(scope.spawn(|| -> Result<(), String> {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(input) = inputs.get(index) else {
                        break;
                    };
                    scan_wat_file(input, suffixes, &handle)?;
                    let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                    eprintln!("WAT {done}/{}: {}", inputs.len(), input.display());
                }
                Ok(())
            }));
        }

        for worker in workers {
            worker.join().map_err(|_| "WAT reader panicked")??;
        }
        Ok(())
    })
}

fn wat_inputs(path: &Path) -> Result<Vec<PathBuf>, String> {
    if path.is_file() {
        return Ok(is_wat_file(path)
            .then(|| path.to_path_buf())
            .into_iter()
            .collect());
    }
    if !path.is_dir() {
        return Err(format!("input path does not exist: {}", path.display()));
    }

    let mut pending = vec![path.to_path_buf()];
    let mut inputs = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|err| format!("could not read {}: {err}", directory.display()))?
        {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if is_wat_file(&path) {
                inputs.push(path);
            }
        }
    }
    inputs.sort();
    Ok(inputs)
}

fn is_wat_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".warc.wat.gz"))
}

fn scan_wat_file<F>(path: &Path, suffixes: &PublicSuffixList, handle: &F) -> Result<(), String>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    let file = open_wat_file(path)?;
    let decoder = MultiGzDecoder::new(file);
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, decoder);
    let mut bytes = Vec::new();

    loop {
        bytes.clear();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|err| format!("could not decompress {}: {err}", path.display()))?;
        if read == 0 {
            break;
        }
        if !bytes.starts_with(br#"{"Container""#) {
            continue;
        }

        let Ok(record) = serde_json::from_slice::<WatRecord>(&bytes) else {
            continue;
        };
        for target in extract_record_urls(record, suffixes) {
            handle(target)?;
        }
    }
    Ok(())
}

fn open_wat_file(path: &Path) -> Result<File, String> {
    let mut last_error = None;
    for attempt in 1..=WAT_OPEN_ATTEMPTS {
        match File::open(path) {
            Ok(file) => return Ok(file),
            Err(error) => {
                last_error = Some(error);
                if attempt < WAT_OPEN_ATTEMPTS {
                    eprintln!(
                        "retrying WAT open {attempt}/{WAT_OPEN_ATTEMPTS}: {}",
                        path.display()
                    );
                    thread::sleep(Duration::from_millis(250 * attempt as u64));
                }
            }
        }
    }
    Err(format!(
        "could not open {} after {WAT_OPEN_ATTEMPTS} attempts: {}",
        path.display(),
        last_error.expect("at least one WAT open attempt")
    ))
}

fn extract_record_urls(record: WatRecord, suffixes: &PublicSuffixList) -> Vec<TrainingUrl> {
    let Some(envelope) = record.envelope else {
        return Vec::new();
    };
    let Some(source_text) = envelope.warc_header.target_uri else {
        return Vec::new();
    };
    let Ok(source) = Url::parse(&source_text) else {
        return Vec::new();
    };
    if source.scheme() != "http" && source.scheme() != "https" {
        return Vec::new();
    }
    let Some(source_identity) = source.host_str().and_then(|host| suffixes.identity(host)) else {
        return Vec::new();
    };
    let Some(html) = envelope
        .payload
        .and_then(|payload| payload.response)
        .and_then(|response| response.html)
    else {
        return Vec::new();
    };
    let document_title = html
        .head
        .and_then(|head| head.title)
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty());
    let Some(links) = html.links else {
        return Vec::new();
    };

    let surface = classify_source_surface(&source_identity.registrable_domain, source.path());
    let mut targets = Vec::new();
    let mut seen_urls = HashSet::new();
    let mut internal_anchors = 0usize;
    let mut reddit_submitted_target_seen = false;

    for link in links {
        if link.path.as_deref() != Some("A@/href") && link.path.as_deref() != Some("AREA@/href") {
            continue;
        }
        if targets.len() >= MAX_ANCHORS_PER_PAGE {
            break;
        }
        let Some(raw_url) = link.url else {
            continue;
        };
        if raw_url.is_empty() || raw_url.len() > MAX_LINK_URL_LENGTH {
            continue;
        }
        let Ok(raw_target) = source.join(&raw_url) else {
            continue;
        };
        if raw_target.scheme() != "http" && raw_target.scheme() != "https" {
            continue;
        }
        let (mut target, unwrapped_redirect) = unwrap_redirect_chain(raw_target);
        let display_text = link
            .text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let (presentation, displayed_target) = classify_link_presentation(
            &source_identity.registrable_domain,
            source.path(),
            &target,
            display_text,
            unwrapped_redirect,
        );
        let mut presentation = presentation;
        if let Some(displayed_target) = displayed_target {
            target = displayed_target;
        }
        let Some(identity) = target.host_str().and_then(|host| suffixes.identity(host)) else {
            continue;
        };
        let normalized_host = if identity.has_www {
            format!("www.{}", identity.hostname)
        } else {
            identity.hostname.clone()
        };
        if target.set_host(Some(&normalized_host)).is_err() {
            continue;
        }

        let internal = identity.registrable_domain == source_identity.registrable_domain;
        if presentation == LinkPresentation::Masked
            && !reddit_submitted_target_seen
            && is_reddit_post(&source_identity.registrable_domain, source.path())
            && !internal
            && !is_reddit_owned_domain(&identity.registrable_domain)
            && reddit_title_matches(display_text, document_title.as_deref())
        {
            presentation = LinkPresentation::SubmittedUrl;
            reddit_submitted_target_seen = true;
        }
        let url = target.to_string();
        if !seen_urls.insert((url.clone(), presentation)) {
            continue;
        }
        if internal {
            internal_anchors += 1;
        }
        targets.push((
            url,
            identity,
            internal,
            presentation,
            display_text.map(|text| truncate_text(text, MAX_RETAINED_DISPLAY_TEXT_LENGTH)),
            truncate_text(&raw_url, MAX_LINK_URL_LENGTH),
        ));
    }

    if targets.is_empty() {
        return Vec::new();
    }
    let directory_page = targets.len() >= 200 && internal_anchors * 10 >= targets.len() * 8;
    let mut per_domain = HashMap::<String, usize>::new();
    let mut output = Vec::new();
    targets.sort_by_key(|(_, _, _, presentation, _, _)| {
        std::cmp::Reverse(presentation_priority(*presentation))
    });

    for (url, identity, internal, presentation, display_text, link_href) in targets {
        let used = per_domain
            .entry(identity.registrable_domain.clone())
            .or_default();
        if *used >= MAX_LINKS_PER_TARGET_DOMAIN_PER_PAGE {
            continue;
        }
        *used += 1;

        let link_class = if internal {
            LinkClass::Internal
        } else if directory_page {
            LinkClass::DirectoryExternal
        } else {
            surface
        };
        output.push(TrainingUrl {
            url,
            hostname: identity.hostname,
            suffix: identity.suffix,
            registrable_domain: identity.registrable_domain,
            has_www: identity.has_www,
            dataset: Dataset::CommonCrawl,
            link_class,
            link_presentation: presentation,
            source_url: Some(truncate_text(&source_text, MAX_RETAINED_SOURCE_URL_LENGTH)),
            source_hostname: Some(source_identity.hostname.clone()),
            source_registrable_domain: Some(source_identity.registrable_domain.clone()),
            display_text,
            link_href: Some(link_href),
            analysis_weight: link_class.default_weight() * presentation.default_weight(),
        });
    }
    output
}

fn classify_link_presentation(
    source_domain: &str,
    source_path: &str,
    target: &Url,
    display_text: Option<&str>,
    unwrapped_redirect: bool,
) -> (LinkPresentation, Option<Url>) {
    let Some(display_text) = display_text else {
        return (
            if unwrapped_redirect && is_submitted_link_surface(source_domain, source_path) {
                LinkPresentation::SubmittedUrl
            } else {
                LinkPresentation::MissingText
            },
            None,
        );
    };
    let Some(displayed_url) = parse_displayed_url(display_text) else {
        return (
            if unwrapped_redirect && is_submitted_link_surface(source_domain, source_path) {
                LinkPresentation::SubmittedUrl
            } else {
                LinkPresentation::Masked
            },
            None,
        );
    };
    if displayed_url_matches_target(&displayed_url, target) {
        return (
            if unwrapped_redirect {
                LinkPresentation::RedirectedUrl
            } else {
                LinkPresentation::VisibleUrl
            },
            None,
        );
    }

    let twitter_source = matches!(source_domain, "x.com" | "twitter.com");
    let tco_target = target
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("t.co"));
    let displayed_tco = displayed_url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("t.co"));
    if twitter_source && tco_target && !displayed_tco {
        return (LinkPresentation::RedirectedUrl, Some(displayed_url));
    }

    if unwrapped_redirect && is_submitted_link_surface(source_domain, source_path) {
        return (LinkPresentation::SubmittedUrl, None);
    }

    (LinkPresentation::Masked, None)
}

pub(crate) fn unwrap_redirect_chain(mut target: Url) -> (Url, bool) {
    let mut changed = false;
    for _ in 0..3 {
        let Some(next) = unwrap_known_redirect(&target) else {
            break;
        };
        if next == target {
            break;
        }
        target = next;
        changed = true;
    }
    (target, changed)
}

fn unwrap_known_redirect(target: &Url) -> Option<Url> {
    let host = target
        .host_str()?
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let path = target.path().trim_end_matches('/').to_ascii_lowercase();

    let parameter = match (host.as_str(), path.as_str()) {
        ("youtube.com" | "m.youtube.com", "/redirect") => &["q", "url"][..],
        ("l.facebook.com" | "lm.facebook.com" | "l.messenger.com", "/l.php") => &["u"][..],
        ("l.instagram.com", "") => &["u"][..],
        ("google.com" | "googleusercontent.com", "/url") => &["q", "url"][..],
        ("linkedin.com", "/redir/redirect" | "/safety/go") => &["url"][..],
        ("out.reddit.com", _) => &["url"][..],
        ("steamcommunity.com", "/linkfilter") => &["url"][..],
        ("discord.com", "/redirect") => &["url"][..],
        ("slack-redir.net", "/link") => &["url"][..],
        ("medium.com", "/r") => &["url"][..],
        _ => &[][..],
    };
    for (key, value) in target.query_pairs() {
        if parameter
            .iter()
            .any(|candidate| key.eq_ignore_ascii_case(candidate))
        {
            return parse_http_url(&value);
        }
    }

    if host == "href.li" {
        let query = target.query()?;
        if let Some(parsed) = parse_http_url(query) {
            return Some(parsed);
        }
        let (decoded, _) = url::form_urlencoded::parse(query.as_bytes()).next()?;
        return parse_http_url(&decoded);
    }
    None
}

fn parse_http_url(value: &str) -> Option<Url> {
    let parsed = Url::parse(value).ok()?;
    matches!(parsed.scheme(), "http" | "https").then_some(parsed)
}

fn is_submitted_link_surface(source_domain: &str, source_path: &str) -> bool {
    match source_domain {
        "x.com" | "twitter.com" | "facebook.com" | "fb.com" | "instagram.com" | "threads.net"
        | "youtube.com" | "linkedin.com" => true,
        "reddit.com" => is_reddit_post(source_domain, source_path),
        _ => false,
    }
}

fn is_reddit_post(source_domain: &str, source_path: &str) -> bool {
    source_domain == "reddit.com" && source_path.to_ascii_lowercase().contains("/comments/")
}

fn is_reddit_owned_domain(domain: &str) -> bool {
    matches!(
        domain,
        "reddit.com"
            | "redd.it"
            | "reddithelp.com"
            | "redditinc.com"
            | "redditmedia.com"
            | "redditstatic.com"
    )
}

fn reddit_title_matches(display_text: Option<&str>, document_title: Option<&str>) -> bool {
    let (Some(display), Some(title)) = (display_text, document_title) else {
        return false;
    };
    let display = normalize_title(display);
    let title = normalize_title(title);
    display.len() >= 4
        && (title == display
            || title.starts_with(&format!("{display} :"))
            || title.starts_with(&format!("{display} -"))
            || title.starts_with(&format!("{display} |")))
}

fn normalize_title(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn parse_displayed_url(text: &str) -> Option<Url> {
    let text = text.trim();
    if text.is_empty() || text.len() > MAX_LINK_URL_LENGTH || text.chars().any(char::is_whitespace)
    {
        return None;
    }
    let text = text
        .trim_matches(|char| matches!(char, '<' | '>' | '"' | '\''))
        .strip_suffix('…')
        .or_else(|| text.strip_suffix("..."))
        .unwrap_or(text);
    if text.is_empty() {
        return None;
    }

    let parsed = Url::parse(text)
        .or_else(|_| Url::parse(&format!("https://{text}")))
        .ok()?;
    matches!(parsed.scheme(), "http" | "https").then_some(parsed)
}

fn displayed_url_matches_target(displayed: &Url, target: &Url) -> bool {
    normalized_host(displayed) == normalized_host(target)
        && displayed.port() == target.port()
        && normalized_path(displayed.path()) == normalized_path(target.path())
        && displayed.query() == target.query()
        && displayed.fragment() == target.fragment()
}

fn normalized_host(url: &Url) -> Option<&str> {
    url.host_str()
        .map(|host| host.strip_prefix("www.").unwrap_or(host))
}

fn normalized_path(path: &str) -> &str {
    if path == "/" {
        ""
    } else {
        path.trim_end_matches('/')
    }
}

fn presentation_priority(presentation: LinkPresentation) -> u8 {
    match presentation {
        LinkPresentation::SubmittedUrl => 3,
        LinkPresentation::VisibleUrl | LinkPresentation::RedirectedUrl => 2,
        LinkPresentation::Masked => 1,
        LinkPresentation::MissingText => 0,
    }
}

fn truncate_text(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn classify_source_surface(host: &str, pathname: &str) -> LinkClass {
    let path = pathname.to_ascii_lowercase();
    if host == "x.com" || host == "twitter.com" {
        return if contains_numbered_status(&path) {
            LinkClass::SocialPost
        } else {
            LinkClass::SocialProfile
        };
    }
    if host == "instagram.com" {
        return if ["/p/", "/reel/", "/reels/", "/tv/"]
            .iter()
            .any(|prefix| path.starts_with(prefix))
        {
            LinkClass::SocialPost
        } else {
            LinkClass::SocialProfile
        };
    }
    if host == "facebook.com" || host == "fb.com" {
        return if ["/posts", "/videos", "/photos", "/permalink", "/story.php"]
            .iter()
            .any(|needle| path.contains(needle))
        {
            LinkClass::SocialPost
        } else {
            LinkClass::SocialProfile
        };
    }
    if host == "threads.net" || host == "bsky.app" || host.ends_with("mastodon.social") {
        return LinkClass::SocialPost;
    }
    if host == "reddit.com" {
        return if path.contains("/comments/") {
            LinkClass::ForumPost
        } else {
            LinkClass::Forum
        };
    }
    if matches!(
        host,
        "tiktok.com" | "youtube.com" | "youtu.be" | "vimeo.com"
    ) {
        return LinkClass::Video;
    }
    if ["forum", "forums", "community", "discuss"]
        .iter()
        .any(|needle| host.contains(needle))
        || [
            "/forum/",
            "/forums/",
            "/thread/",
            "/threads/",
            "/topic/",
            "/topics/",
        ]
        .iter()
        .any(|needle| path.contains(needle))
    {
        return LinkClass::Forum;
    }
    if ["news", "blog"].iter().any(|needle| host.contains(needle))
        || ["/news/", "/blog/", "/article/", "/articles/"]
            .iter()
            .any(|needle| path.contains(needle))
    {
        return LinkClass::BlogNews;
    }
    LinkClass::Web
}

fn contains_numbered_status(path: &str) -> bool {
    let Some((_, tail)) = path.split_once("/status/") else {
        return false;
    };
    tail.as_bytes().first().is_some_and(u8::is_ascii_digit)
}

#[derive(Deserialize)]
struct WatRecord {
    #[serde(rename = "Envelope")]
    envelope: Option<Envelope>,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(rename = "WARC-Header-Metadata", default)]
    warc_header: WarcHeader,
    #[serde(rename = "Payload-Metadata")]
    payload: Option<PayloadMetadata>,
}

#[derive(Default, Deserialize)]
struct WarcHeader {
    #[serde(rename = "WARC-Target-URI")]
    target_uri: Option<String>,
}

#[derive(Deserialize)]
struct PayloadMetadata {
    #[serde(rename = "HTTP-Response-Metadata")]
    response: Option<ResponseMetadata>,
}

#[derive(Deserialize)]
struct ResponseMetadata {
    #[serde(rename = "HTML-Metadata")]
    html: Option<HtmlMetadata>,
}

#[derive(Deserialize)]
struct HtmlMetadata {
    #[serde(rename = "Head")]
    head: Option<WatHead>,
    #[serde(rename = "Links")]
    links: Option<Vec<WatLink>>,
}

#[derive(Deserialize)]
struct WatHead {
    #[serde(rename = "Title")]
    title: Option<String>,
}

#[derive(Deserialize)]
struct WatLink {
    path: Option<String>,
    url: Option<String>,
    text: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{classify_source_surface, read_wat_urls, unwrap_known_redirect, WatRecord};
    use crate::corpus::{LinkClass, LinkPresentation};
    use crate::public_suffix::PublicSuffixList;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use std::sync::Mutex;
    use url::Url;

    const RECORD: &str = r#"{"Container":{},"Envelope":{"WARC-Header-Metadata":{"WARC-Target-URI":"https://twitter.com/mia/status/123"},"Payload-Metadata":{"HTTP-Response-Metadata":{"HTML-Metadata":{"Links":[{"path":"IMG@/src","url":"https://ignored.example/image.png"},{"path":"A@/href","url":"https://example.com/a","text":"example.com/a"},{"path":"A@/href","url":"https://example.com/a","text":"example.com/a"},{"path":"AREA@/href","url":"/mia/status/456","text":"next"},{"path":"A@/href","url":"mailto:test@example.com"}]}}}}}"#;
    const TCO_RECORD: &str = r#"{"Container":{},"Envelope":{"WARC-Header-Metadata":{"WARC-Target-URI":"https://x.com/mia/status/123"},"Payload-Metadata":{"HTTP-Response-Metadata":{"HTML-Metadata":{"Links":[{"path":"A@/href","url":"https://t.co/abc123","text":"example.com/very/long/path…"}]}}}}}"#;
    const YOUTUBE_REDIRECT_RECORD: &str = r#"{"Container":{},"Envelope":{"WARC-Header-Metadata":{"WARC-Target-URI":"https://www.youtube.com/watch?v=abc"},"Payload-Metadata":{"HTTP-Response-Metadata":{"HTML-Metadata":{"Links":[{"path":"A@/href","url":"https://www.youtube.com/redirect?event=video_description&q=https%3A%2F%2Fexample.com%2Fcreator%2Fpage","text":"example.com/creator/page"}]}}}}}"#;
    const FACEBOOK_SHIM_RECORD: &str = r#"{"Container":{},"Envelope":{"WARC-Header-Metadata":{"WARC-Target-URI":"https://www.facebook.com/example/posts/123"},"Payload-Metadata":{"HTTP-Response-Metadata":{"HTML-Metadata":{"Links":[{"path":"A@/href","url":"https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Farticle%3Fid%3D7&h=tracking","text":"An interesting article"}]}}}}}"#;
    const REDDIT_LINK_POST_RECORD: &str = r#"{"Container":{},"Envelope":{"WARC-Header-Metadata":{"WARC-Target-URI":"https://www.reddit.com/r/rust/comments/abc/excellent_article/"},"Payload-Metadata":{"HTTP-Response-Metadata":{"HTML-Metadata":{"Head":{"Title":"Excellent article : r/rust"},"Links":[{"path":"A@/href","url":"/r/rust/","text":"r/rust"},{"path":"A@/href","url":"https://example.com/article","text":"Excellent article"},{"path":"A@/href","url":"https://docs.example.com/reference","text":"documentation"}]}}}}}"#;

    #[test]
    fn resolves_filters_deduplicates_and_classifies_links() {
        let suffixes = PublicSuffixList::from_text("com\n");
        let record = serde_json::from_str::<WatRecord>(RECORD).unwrap();
        let urls = super::extract_record_urls(record, &suffixes);

        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0].url, "https://example.com/a");
        assert_eq!(urls[0].link_class, LinkClass::SocialPost);
        assert_eq!(urls[0].link_presentation, LinkPresentation::VisibleUrl);
        assert_eq!(
            urls[0].source_registrable_domain.as_deref(),
            Some("twitter.com")
        );
        assert_eq!(urls[1].url, "https://twitter.com/mia/status/456");
        assert_eq!(urls[1].link_class, LinkClass::Internal);
        assert_eq!(urls[1].link_presentation, LinkPresentation::Masked);
    }

    #[test]
    fn uses_twitter_display_url_instead_of_tco_redirect() {
        let suffixes = PublicSuffixList::from_text("com\n");
        let record = serde_json::from_str::<WatRecord>(TCO_RECORD).unwrap();
        let urls = super::extract_record_urls(record, &suffixes);

        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].url, "https://example.com/very/long/path");
        assert_eq!(urls[0].registrable_domain, "example.com");
        assert_eq!(urls[0].link_presentation, LinkPresentation::RedirectedUrl);
        assert_eq!(urls[0].link_href.as_deref(), Some("https://t.co/abc123"));
        assert_eq!(urls[0].source_registrable_domain.as_deref(), Some("x.com"));
    }

    #[test]
    fn unwraps_youtube_redirect_and_preserves_original_href() {
        let suffixes = PublicSuffixList::from_text("com\n");
        let record = serde_json::from_str::<WatRecord>(YOUTUBE_REDIRECT_RECORD).unwrap();
        let urls = super::extract_record_urls(record, &suffixes);

        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].url, "https://example.com/creator/page");
        assert_eq!(urls[0].link_class, LinkClass::Video);
        assert_eq!(urls[0].link_presentation, LinkPresentation::RedirectedUrl);
        assert!(urls[0]
            .link_href
            .as_deref()
            .unwrap()
            .starts_with("https://www.youtube.com/redirect?"));
    }

    #[test]
    fn treats_unwrapped_facebook_link_cards_as_submitted_urls() {
        let suffixes = PublicSuffixList::from_text("com\n");
        let record = serde_json::from_str::<WatRecord>(FACEBOOK_SHIM_RECORD).unwrap();
        let urls = super::extract_record_urls(record, &suffixes);

        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].url, "https://example.com/article?id=7");
        assert_eq!(urls[0].link_class, LinkClass::SocialPost);
        assert_eq!(urls[0].link_presentation, LinkPresentation::SubmittedUrl);
        assert_eq!(urls[0].analysis_weight, 64);
    }

    #[test]
    fn recognizes_reddit_link_post_target_without_promoting_comment_links() {
        let suffixes = PublicSuffixList::from_text("com\n");
        let record = serde_json::from_str::<WatRecord>(REDDIT_LINK_POST_RECORD).unwrap();
        let urls = super::extract_record_urls(record, &suffixes);

        let submitted = urls
            .iter()
            .find(|url| url.url == "https://example.com/article")
            .unwrap();
        assert_eq!(submitted.link_class, LinkClass::ForumPost);
        assert_eq!(submitted.link_presentation, LinkPresentation::SubmittedUrl);
        assert_eq!(submitted.analysis_weight, 40);

        let comment_link = urls
            .iter()
            .find(|url| url.url == "https://docs.example.com/reference")
            .unwrap();
        assert_eq!(comment_link.link_presentation, LinkPresentation::Masked);
        assert_eq!(comment_link.analysis_weight, 0);
    }

    #[test]
    fn unwraps_other_query_parameter_redirect_shims() {
        let cases = [
            (
                "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa",
                "https://example.com/a",
            ),
            (
                "https://www.linkedin.com/safety/go?url=https%3A%2F%2Fexample.com%2Fb",
                "https://example.com/b",
            ),
            (
                "https://steamcommunity.com/linkfilter/?url=https%3A%2F%2Fexample.com%2Fc",
                "https://example.com/c",
            ),
            (
                "https://href.li/?https://example.com/d",
                "https://example.com/d",
            ),
        ];
        for (shim, expected) in cases {
            let shim = Url::parse(shim).unwrap();
            assert_eq!(unwrap_known_redirect(&shim).unwrap().as_str(), expected);
        }
    }

    #[test]
    fn streams_gzipped_wat_without_extracting_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fixture.warc.wat.gz");
        let file = std::fs::File::create(&path).unwrap();
        let mut gzip = GzEncoder::new(file, Compression::fast());
        writeln!(gzip, "WARC/1.0").unwrap();
        writeln!(gzip, "{RECORD}").unwrap();
        gzip.finish().unwrap();

        let suffixes = PublicSuffixList::from_text("com\n");
        let found = Mutex::new(Vec::new());
        read_wat_urls(&path, 2, &suffixes, |url| {
            found.lock().unwrap().push(url);
            Ok(())
        })
        .unwrap();

        assert_eq!(found.into_inner().unwrap().len(), 2);
    }

    #[test]
    fn recognizes_source_surfaces() {
        assert_eq!(
            classify_source_surface("reddit.com", "/r/rust/comments/abc/title"),
            LinkClass::ForumPost
        );
        assert_eq!(
            classify_source_surface("news.example.com", "/story"),
            LinkClass::BlogNews
        );
        assert_eq!(
            classify_source_surface("example.com", "/about"),
            LinkClass::Web
        );
    }
}
