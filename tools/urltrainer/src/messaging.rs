use crate::args::{Args, MessagingMediaFilter};
use crate::corpus::{Dataset, LinkClass, LinkPresentation, TrainingUrl};
use crate::public_suffix::PublicSuffixList;
use flate2::read::MultiGzDecoder;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::de::{DeserializeSeed, Error as DeError, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tar::Archive;
use url::Url;
use zip::ZipArchive;

const MAX_URL_LENGTH: usize = 16_384;
const MAX_FAILURE_DETAILS: usize = 1_000;
const MESSAGE_LIMIT_REACHED: &str = "messaging-message-limit-reached";
const OUTPUT_SINK_FAILED: &str = "messaging-output-sink-failed";

const GIF_HOSTS: &[&str] = &[
    "tenor.com",
    "giphy.com",
    "gfycat.com",
    "redgifs.com",
    "gifer.com",
    "gifbin.com",
    "reactiongifs.com",
    "makeagif.com",
];

const EMBED_IMAGE_HOSTS: &[&str] = &[
    "imgur.com",
    "prnt.sc",
    "prntscr.com",
    "lightshot.com",
    "gyazo.com",
    "ibb.co",
    "imgbb.com",
    "postimg.cc",
    "postimages.org",
    "imagebam.com",
    "imagevenue.com",
    "cdn.discordapp.com",
    "media.discordapp.net",
];

const SHORTENER_HOSTS: &[&str] = &[
    "amzn.to",
    "bit.ly",
    "bl.ink",
    "buff.ly",
    "clck.ru",
    "cutt.ly",
    "dlvr.it",
    "fb.me",
    "goo.gl",
    "is.gd",
    "ift.tt",
    "j.mp",
    "lnkd.in",
    "ow.ly",
    "rb.gy",
    "rebrand.ly",
    "short.io",
    "shorturl.at",
    "soo.gd",
    "s.id",
    "t.co",
    "t.ly",
    "t.me",
    "tiny.cc",
    "tiny.one",
    "tinyurl.com",
    "trib.al",
    "v.gd",
    "urlz.fr",
    "wa.me",
    "youtu.be",
];

#[derive(Debug, Default)]
pub struct MessagingSummary {
    pub input_files: u64,
    pub recoverable_failures: u64,
    pub failed_inputs: u64,
    pub failed_members: u64,
    pub failed_records: u64,
    pub suppressed_failure_details: u64,
    pub failures: Vec<MessagingFailure>,
    pub messages_seen: u64,
    pub malformed_messages: u64,
    pub bot_messages_skipped: u64,
    pub candidates_seen: u64,
    pub accepted_urls: u64,
    pub duplicates_skipped: u64,
    pub invalid_urls: u64,
    pub filtered_urls: u64,
    pub filtered_hosts: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessagingFailure {
    pub dataset: String,
    pub input: String,
    pub member: Option<String>,
    pub scope: &'static str,
    pub stage: &'static str,
    pub error: String,
}

impl MessagingSummary {
    pub fn display(&self) -> String {
        let filtered = self
            .filtered_hosts
            .iter()
            .map(|(host, count)| format!("{host}={count}"))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "messaging sanitizer files={} failures={} failed-inputs={} failed-members={} failed-records={} failure-details-suppressed={} messages={} malformed={} accepted={} candidates={} bots-skipped={} duplicates={} invalid={} filtered={} filtered-hosts=[{}]",
            self.input_files,
            self.recoverable_failures,
            self.failed_inputs,
            self.failed_members,
            self.failed_records,
            self.suppressed_failure_details,
            self.messages_seen,
            self.malformed_messages,
            self.accepted_urls,
            self.candidates_seen,
            self.bot_messages_skipped,
            self.duplicates_skipped,
            self.invalid_urls,
            self.filtered_urls,
            filtered,
        )
    }
}

#[derive(Copy, Clone)]
enum Platform {
    Discord,
    Telegram,
    Whatsapp,
}

struct MessageCandidate {
    value: String,
    presentation: LinkPresentation,
}

impl MessageCandidate {
    fn visible(value: String) -> Self {
        Self {
            value,
            presentation: LinkPresentation::VisibleUrl,
        }
    }

    fn masked(value: String) -> Self {
        Self {
            value,
            presentation: LinkPresentation::Masked,
        }
    }
}

impl Platform {
    fn source_domain(self) -> &'static str {
        match self {
            Self::Discord => "discord.com",
            Self::Telegram => "telegram.org",
            Self::Whatsapp => "whatsapp.com",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum MessagingInputKind {
    DiscordUnveiled,
    TgDataset,
    Disco,
    TelegramGroupverse,
    Whatsapp,
}

impl MessagingInputKind {
    fn dataset_name(self) -> &'static str {
        match self {
            Self::DiscordUnveiled => "discord-unveiled",
            Self::TgDataset => "tgdataset",
            Self::Disco => "disco",
            Self::TelegramGroupverse => "telegram-groupverse",
            Self::Whatsapp => "whatsapp-public-groups",
        }
    }
}

struct MessagingInput {
    path: PathBuf,
    kind: MessagingInputKind,
}

struct MessagingSink<'a, F> {
    args: &'a Args,
    suffixes: &'a PublicSuffixList,
    handle: &'a F,
    blocked_hosts: HashSet<String>,
    output_error: Option<String>,
    summary: MessagingSummary,
}

impl<'a, F> MessagingSink<'a, F>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    fn new(args: &'a Args, suffixes: &'a PublicSuffixList, handle: &'a F) -> Self {
        Self {
            args,
            suffixes,
            handle,
            blocked_hosts: blocked_hosts(args),
            output_error: None,
            summary: MessagingSummary::default(),
        }
    }

    fn report_failure(
        &mut self,
        kind: MessagingInputKind,
        input: &Path,
        member: Option<&str>,
        scope: &'static str,
        stage: &'static str,
        error: impl fmt::Display,
    ) {
        let failure = MessagingFailure {
            dataset: kind.dataset_name().to_string(),
            input: input.display().to_string(),
            member: member.map(str::to_string),
            scope,
            stage,
            error: sanitize_error(error),
        };
        self.summary.recoverable_failures += 1;
        match scope {
            "input" => self.summary.failed_inputs += 1,
            "member" => self.summary.failed_members += 1,
            "record" => self.summary.failed_records += 1,
            _ => {}
        }
        if self.summary.failures.len() < MAX_FAILURE_DETAILS {
            eprintln!(
                "messaging sanitizer skipped dataset={} scope={} stage={} input={} member={} error={}",
                failure.dataset,
                failure.scope,
                failure.stage,
                failure.input,
                failure.member.as_deref().unwrap_or("-"),
                failure.error,
            );
            self.summary.failures.push(failure);
        } else {
            self.summary.suppressed_failure_details += 1;
            if self.summary.suppressed_failure_details == 1 {
                eprintln!(
                    "messaging sanitizer failure detail limit reached; further failures remain counted"
                );
            }
        }
    }

    fn output_failed(&self) -> bool {
        self.output_error.is_some()
    }

    fn take_output_error(&mut self) -> Option<String> {
        self.output_error.take()
    }

    fn accept_message<I>(
        &mut self,
        text: &str,
        extra_candidates: I,
        platform: Platform,
        dataset: Dataset,
        forwarded: bool,
    ) -> Result<(), String>
    where
        I: IntoIterator<Item = MessageCandidate>,
    {
        self.summary.messages_seen += 1;
        let mut candidates = extract_http_urls(text)
            .into_iter()
            .map(MessageCandidate::visible)
            .collect::<Vec<_>>();
        candidates.extend(extra_candidates);
        let mut raw_candidates = HashSet::new();
        let mut message_urls = HashSet::new();

        for candidate in candidates {
            if !raw_candidates.insert(candidate.value.clone()) {
                self.summary.duplicates_skipped += 1;
                continue;
            }
            self.summary.candidates_seen += 1;
            let Some((parsed, original)) = parse_candidate(&candidate.value) else {
                self.summary.invalid_urls += 1;
                continue;
            };
            let (target, unwrapped) = crate::wat::unwrap_redirect_chain(parsed);
            let Some(host) = target.host_str().map(normalize_host) else {
                self.summary.invalid_urls += 1;
                continue;
            };
            if let Some(blocked) = matching_blocked_host(&host, &self.blocked_hosts) {
                self.summary.filtered_urls += 1;
                *self
                    .summary
                    .filtered_hosts
                    .entry(blocked.to_string())
                    .or_default() += 1;
                continue;
            }

            let normalized = target.to_string();
            if !message_urls.insert(normalized.clone()) {
                self.summary.duplicates_skipped += 1;
                continue;
            }

            let link_class = if forwarded {
                LinkClass::ForwardedMessage
            } else {
                LinkClass::Message
            };
            let Some(mut record) =
                TrainingUrl::from_absolute(&normalized, link_class, self.suffixes)
            else {
                self.summary.invalid_urls += 1;
                continue;
            };
            let presentation = if candidate.presentation == LinkPresentation::Masked {
                LinkPresentation::Masked
            } else if unwrapped {
                LinkPresentation::RedirectedUrl
            } else {
                LinkPresentation::VisibleUrl
            };
            record.link_presentation = presentation;
            record.dataset = dataset;
            record.source_hostname = Some(platform.source_domain().to_string());
            record.source_registrable_domain = Some(platform.source_domain().to_string());
            record.display_text =
                (presentation != LinkPresentation::Masked).then(|| original.clone());
            record.link_href = Some(original);
            record.analysis_weight = link_class.default_weight() * presentation.default_weight();
            if let Err(error) = (self.handle)(record) {
                self.output_error = Some(error);
                return Err(OUTPUT_SINK_FAILED.to_string());
            }
            self.summary.accepted_urls += 1;
        }
        Ok(())
    }

    fn message_limit_reached(&self) -> bool {
        self.args.messaging_message_limit != 0
            && self.summary.messages_seen >= self.args.messaging_message_limit
    }
}

pub fn read_messaging_urls<F>(
    path: &Path,
    args: &Args,
    suffixes: &PublicSuffixList,
    handle: F,
) -> Result<MessagingSummary, String>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    let inputs = messaging_inputs(path)?;
    if inputs.is_empty() {
        return Err(format!(
            "no supported messaging archives found under {}",
            path.display()
        ));
    }

    let mut sink = MessagingSink::new(args, suffixes, &handle);
    for input in inputs {
        sink.summary.input_files += 1;
        eprintln!("messaging sanitizer reading {}", input.path.display());
        if let Err(error) = input.read(&mut sink) {
            if let Some(output_error) = sink.take_output_error() {
                return Err(format!("messaging output sink failed: {output_error}"));
            }
            if error.contains(MESSAGE_LIMIT_REACHED) {
                break;
            }
            sink.report_failure(input.kind, &input.path, None, "input", "read", error);
        }
        if sink.message_limit_reached() {
            break;
        }
    }
    Ok(sink.summary)
}

impl MessagingInput {
    fn read<F>(&self, sink: &mut MessagingSink<'_, F>) -> Result<(), String>
    where
        F: Fn(TrainingUrl) -> Result<(), String>,
    {
        match self.kind {
            MessagingInputKind::DiscordUnveiled => read_discord_unveiled(&self.path, sink),
            MessagingInputKind::TgDataset => read_tgdataset(&self.path, sink),
            MessagingInputKind::Disco => read_disco(&self.path, sink),
            MessagingInputKind::TelegramGroupverse => read_telegram_groupverse(&self.path, sink),
            MessagingInputKind::Whatsapp => read_whatsapp(&self.path, sink),
        }
    }
}

fn recover_member_error<F>(
    sink: &mut MessagingSink<'_, F>,
    kind: MessagingInputKind,
    input: &Path,
    member: &str,
    stage: &'static str,
    error: impl fmt::Display,
) -> Result<(), String>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    let error = error.to_string();
    if error.contains(MESSAGE_LIMIT_REACHED) || sink.message_limit_reached() {
        return Err(MESSAGE_LIMIT_REACHED.to_string());
    }
    if sink.output_failed() {
        return Err(OUTPUT_SINK_FAILED.to_string());
    }
    sink.report_failure(kind, input, Some(member), "member", stage, error);
    Ok(())
}

fn sanitize_error(error: impl fmt::Display) -> String {
    const MAX_ERROR_CHARS: usize = 500;
    let normalized = error.to_string().replace(['\r', '\n'], " ");
    let mut characters = normalized.chars();
    let truncated = characters
        .by_ref()
        .take(MAX_ERROR_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn messaging_inputs(path: &Path) -> Result<Vec<MessagingInput>, String> {
    let mut paths = Vec::new();
    collect_files(path, &mut paths)?;
    paths.sort();
    Ok(paths
        .into_iter()
        .filter_map(|path| classify_input(&path).map(|kind| MessagingInput { path, kind }))
        .collect())
}

fn collect_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|err| format!("{}: {err}", path.display()))? {
        let entry = entry.map_err(|err| err.to_string())?;
        let child = entry.path();
        if child.is_dir() {
            collect_files(&child, files)?;
        } else if child.is_file() {
            files.push(child);
        }
    }
    Ok(())
}

fn classify_input(path: &Path) -> Option<MessagingInputKind> {
    let filename = path.file_name()?.to_str()?;
    let full = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if filename == "dataset.zst" && full.contains("discord-unveiled") {
        return Some(MessagingInputKind::DiscordUnveiled);
    }
    if filename.starts_with("TGDataset_") && filename.ends_with(".tar.gz") {
        return Some(MessagingInputKind::TgDataset);
    }
    if filename.starts_with("DISCO-") && filename.ends_with(".zip") {
        return Some(MessagingInputKind::Disco);
    }
    if filename == "sample.zip" && full.contains("telegram-groupverse") {
        return Some(MessagingInputKind::TelegramGroupverse);
    }
    if filename == "anonymised_data_to_share.tsv" {
        return Some(MessagingInputKind::Whatsapp);
    }
    None
}

fn read_discord_unveiled<F>(path: &Path, sink: &mut MessagingSink<'_, F>) -> Result<(), String>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    let file = File::open(path).map_err(|err| format!("{}: {err}", path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(BufReader::new(file))
        .map_err(|err| format!("{}: {err}", path.display()))?;
    let mut archive = Archive::new(decoder);
    let entries = archive.entries().map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let entry_path = entry.path().map_err(|err| err.to_string())?.into_owned();
        if entry_path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let mut reader = BufReader::new(entry);
        let mut line = Vec::new();
        let mut line_number = 0_u64;
        loop {
            line.clear();
            let bytes = reader
                .read_until(b'\n', &mut line)
                .map_err(|err| err.to_string())?;
            if bytes == 0 {
                break;
            }
            line_number += 1;
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            let message: DiscordMessage = match serde_json::from_slice(&line) {
                Ok(message) => message,
                Err(_) => {
                    sink.summary.messages_seen += 1;
                    sink.summary.malformed_messages += 1;
                    sink.report_failure(
                        MessagingInputKind::DiscordUnveiled,
                        path,
                        Some(&format!("{}:{line_number}", entry_path.display())),
                        "record",
                        "parse-json",
                        "malformed JSON record",
                    );
                    if sink.message_limit_reached() {
                        return Ok(());
                    }
                    continue;
                }
            };
            if !sink.args.messaging_include_bots && message.is_bot() {
                sink.summary.messages_seen += 1;
                sink.summary.bot_messages_skipped += 1;
                if sink.message_limit_reached() {
                    return Ok(());
                }
                continue;
            }
            sink.accept_message(
                &message.content,
                std::iter::empty(),
                Platform::Discord,
                Dataset::DiscordUnveiled,
                false,
            )?;
            if sink.message_limit_reached() {
                return Ok(());
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct DiscordMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    is_bot: bool,
    author: Option<DiscordAuthor>,
}

impl DiscordMessage {
    fn is_bot(&self) -> bool {
        self.is_bot || self.author.as_ref().is_some_and(|author| author.bot)
    }
}

#[derive(Deserialize)]
struct DiscordAuthor {
    #[serde(default)]
    bot: bool,
}

fn read_tgdataset<F>(path: &Path, sink: &mut MessagingSink<'_, F>) -> Result<(), String>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    let file = File::open(path).map_err(|err| format!("{}: {err}", path.display()))?;
    let gzip = MultiGzDecoder::new(BufReader::new(file));
    let mut archive = Archive::new(gzip);
    let entries = archive.entries().map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let entry_path = entry.path().map_err(|err| err.to_string())?.into_owned();
        if entry_path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(entry));
        if let Err(err) = (TgRootSeed { sink }).deserialize(&mut deserializer) {
            recover_member_error(
                sink,
                MessagingInputKind::TgDataset,
                path,
                &entry_path.display().to_string(),
                "parse-json",
                err,
            )?;
        }
    }
    Ok(())
}

struct TgRootSeed<'a, 'b, F> {
    sink: &'a mut MessagingSink<'b, F>,
}

impl<'de, F> DeserializeSeed<'de> for TgRootSeed<'_, '_, F>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(TgRootVisitor { sink: self.sink })
    }
}

struct TgRootVisitor<'a, 'b, F> {
    sink: &'a mut MessagingSink<'b, F>,
}

impl<'de, F> Visitor<'de> for TgRootVisitor<'_, '_, F>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a TGDataset channel map")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while map.next_key::<IgnoredAny>()?.is_some() {
            map.next_value_seed(TgChannelSeed { sink: self.sink })?;
        }
        Ok(())
    }
}

struct TgChannelSeed<'a, 'b, F> {
    sink: &'a mut MessagingSink<'b, F>,
}

impl<'de, F> DeserializeSeed<'de> for TgChannelSeed<'_, '_, F>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(TgChannelVisitor { sink: self.sink })
    }
}

struct TgChannelVisitor<'a, 'b, F> {
    sink: &'a mut MessagingSink<'b, F>,
}

impl<'de, F> Visitor<'de> for TgChannelVisitor<'_, '_, F>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a TGDataset channel")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while let Some(key) = map.next_key::<String>()? {
            if key == "text_messages" {
                map.next_value_seed(TgMessagesSeed { sink: self.sink })?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(())
    }
}

struct TgMessagesSeed<'a, 'b, F> {
    sink: &'a mut MessagingSink<'b, F>,
}

impl<'de, F> DeserializeSeed<'de> for TgMessagesSeed<'_, '_, F>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(TgMessagesVisitor { sink: self.sink })
    }
}

struct TgMessagesVisitor<'a, 'b, F> {
    sink: &'a mut MessagingSink<'b, F>,
}

impl<'de, F> Visitor<'de> for TgMessagesVisitor<'_, '_, F>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a TGDataset message map")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while map.next_key::<IgnoredAny>()?.is_some() {
            let message = map.next_value::<TgMessage>()?;
            self.sink
                .accept_message(
                    &message.message,
                    std::iter::empty(),
                    Platform::Telegram,
                    Dataset::TgArchive,
                    message.is_forwarded,
                )
                .map_err(A::Error::custom)?;
            if self.sink.message_limit_reached() {
                return Err(A::Error::custom(MESSAGE_LIMIT_REACHED));
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct TgMessage {
    #[serde(default)]
    message: String,
    #[serde(default)]
    is_forwarded: bool,
}

fn read_disco<F>(path: &Path, sink: &mut MessagingSink<'_, F>) -> Result<(), String>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    let file = File::open(path).map_err(|err| format!("{}: {err}", path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|err| err.to_string())?;
    for index in 0..archive.len() {
        let entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(error) => {
                recover_member_error(
                    sink,
                    MessagingInputKind::Disco,
                    path,
                    &format!("archive-index:{index}"),
                    "open-member",
                    error,
                )?;
                continue;
            }
        };
        let name = entry.name().replace('\\', "/");
        if !name.starts_with("data/") || !name.ends_with(".xml") {
            continue;
        }
        if let Err(error) = read_disco_xml(BufReader::new(entry), sink) {
            recover_member_error(
                sink,
                MessagingInputKind::Disco,
                path,
                &name,
                "parse-xml",
                error,
            )?;
        }
        if sink.message_limit_reached() {
            return Ok(());
        }
    }
    Ok(())
}

fn read_disco_xml<R, F>(reader: R, sink: &mut MessagingSink<'_, F>) -> Result<(), String>
where
    R: BufRead,
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut in_text = false;
    let mut text = String::new();
    loop {
        match xml
            .read_event_into(&mut buffer)
            .map_err(|err| err.to_string())?
        {
            Event::Start(event) if event.name().as_ref() == b"text" => {
                in_text = true;
                text.clear();
            }
            Event::Text(event) if in_text => {
                text.push_str(&event.decode().map_err(|err| err.to_string())?);
            }
            Event::CData(event) if in_text => {
                text.push_str(
                    &xml.decoder()
                        .decode(event.as_ref())
                        .map_err(|err| err.to_string())?,
                );
            }
            Event::End(event) if event.name().as_ref() == b"text" => {
                sink.accept_message(
                    &text,
                    std::iter::empty(),
                    Platform::Discord,
                    Dataset::Disco,
                    false,
                )?;
                if sink.message_limit_reached() {
                    return Ok(());
                }
                in_text = false;
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(())
}

fn read_telegram_groupverse<F>(path: &Path, sink: &mut MessagingSink<'_, F>) -> Result<(), String>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    let file = File::open(path).map_err(|err| format!("{}: {err}", path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|err| err.to_string())?;
    for index in 0..archive.len() {
        let entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(error) => {
                recover_member_error(
                    sink,
                    MessagingInputKind::TelegramGroupverse,
                    path,
                    &format!("archive-index:{index}"),
                    "open-member",
                    error,
                )?;
                continue;
            }
        };
        let name = entry.name().replace('\\', "/");
        if !name.ends_with(".json")
            || name.ends_with("groups.json")
            || name.contains(".ipynb_checkpoints/")
        {
            continue;
        }
        let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(entry));
        if let Err(err) = (TelegramArraySeed { sink }).deserialize(&mut deserializer) {
            recover_member_error(
                sink,
                MessagingInputKind::TelegramGroupverse,
                path,
                &name,
                "parse-json",
                err,
            )?;
        }
    }
    Ok(())
}

struct TelegramArraySeed<'a, 'b, F> {
    sink: &'a mut MessagingSink<'b, F>,
}

impl<'de, F> DeserializeSeed<'de> for TelegramArraySeed<'_, '_, F>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_seq(TelegramArrayVisitor { sink: self.sink })
    }
}

struct TelegramArrayVisitor<'a, 'b, F> {
    sink: &'a mut MessagingSink<'b, F>,
}

impl<'de, F> Visitor<'de> for TelegramArrayVisitor<'_, '_, F>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a Telegram message array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while let Some(message) = sequence.next_element::<TelegramSampleMessage>()? {
            let extra_urls = message.entity_candidates();
            self.sink
                .accept_message(
                    &message.message,
                    extra_urls,
                    Platform::Telegram,
                    Dataset::TelegramGroupverse,
                    message.fwd_from.is_some(),
                )
                .map_err(A::Error::custom)?;
            if self.sink.message_limit_reached() {
                return Err(A::Error::custom(MESSAGE_LIMIT_REACHED));
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct TelegramSampleMessage {
    #[serde(default)]
    message: String,
    #[serde(default)]
    entities: Vec<TelegramEntity>,
    fwd_from: Option<IgnoredAny>,
}

impl TelegramSampleMessage {
    fn entity_candidates(&self) -> Vec<MessageCandidate> {
        self.entities
            .iter()
            .filter_map(|entity| {
                if let Some(url) = &entity.url {
                    return Some(MessageCandidate::masked(url.clone()));
                }
                (entity.kind == "MessageEntityUrl")
                    .then(|| utf16_slice(&self.message, entity.offset?, entity.length?))?
                    .map(MessageCandidate::visible)
            })
            .collect()
    }
}

#[derive(Deserialize)]
struct TelegramEntity {
    #[serde(rename = "_")]
    #[serde(default)]
    kind: String,
    url: Option<String>,
    offset: Option<usize>,
    length: Option<usize>,
}

fn utf16_slice(text: &str, offset: usize, length: usize) -> Option<String> {
    let units = text.encode_utf16().collect::<Vec<_>>();
    let end = offset.checked_add(length)?;
    (end <= units.len()).then(|| String::from_utf16(&units[offset..end]).ok())?
}

fn read_whatsapp<F>(path: &Path, sink: &mut MessagingSink<'_, F>) -> Result<(), String>
where
    F: Fn(TrainingUrl) -> Result<(), String>,
{
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b'\t')
        .flexible(true)
        .from_path(path)
        .map_err(|err| err.to_string())?;
    for (index, row) in reader.deserialize::<WhatsappRow>().enumerate() {
        let row = match row {
            Ok(row) => row,
            Err(error) => {
                sink.summary.messages_seen += 1;
                sink.summary.malformed_messages += 1;
                sink.report_failure(
                    MessagingInputKind::Whatsapp,
                    path,
                    Some(&format!("row:{}", index + 2)),
                    "record",
                    "parse-tsv",
                    error,
                );
                if sink.message_limit_reached() {
                    break;
                }
                continue;
            }
        };
        sink.accept_message(
            "",
            row.media_url
                .into_iter()
                .filter(|url| {
                    let url = url.trim();
                    url.starts_with("http://") || url.starts_with("https://")
                })
                .map(MessageCandidate::visible),
            Platform::Whatsapp,
            Dataset::WhatsappPublicGroups,
            false,
        )?;
        if sink.message_limit_reached() {
            break;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct WhatsappRow {
    media_url: Option<String>,
}

fn blocked_hosts(args: &Args) -> HashSet<String> {
    let mut hosts = SHORTENER_HOSTS
        .iter()
        .map(|host| host.to_string())
        .collect::<HashSet<_>>();
    if matches!(
        args.messaging_media_filter,
        MessagingMediaFilter::Gif | MessagingMediaFilter::Expanded
    ) {
        hosts.extend(GIF_HOSTS.iter().map(|host| host.to_string()));
    }
    if args.messaging_media_filter == MessagingMediaFilter::Expanded {
        hosts.extend(EMBED_IMAGE_HOSTS.iter().map(|host| host.to_string()));
    }
    hosts.extend(
        args.messaging_exclude_hosts
            .iter()
            .map(|host| normalize_host(host)),
    );
    hosts
}

fn matching_blocked_host<'a>(host: &str, blocked: &'a HashSet<String>) -> Option<&'a str> {
    blocked.iter().find_map(|candidate| {
        (host == candidate || host.ends_with(&format!(".{candidate}")))
            .then_some(candidate.as_str())
    })
}

fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_end_matches('.')
        .trim_start_matches("www.")
        .to_ascii_lowercase()
}

fn extract_http_urls(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut urls = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let scheme_length = if starts_with_ascii_case(&bytes[index..], b"https://") {
            8
        } else if starts_with_ascii_case(&bytes[index..], b"http://") {
            7
        } else {
            index += 1;
            continue;
        };
        let start = index;
        index += scheme_length;
        while index < bytes.len() {
            let Some(character) = text[index..].chars().next() else {
                break;
            };
            if character.is_whitespace()
                || matches!(character, '<' | '>' | '"' | '\'' | '`' | '|' | '\\')
            {
                break;
            }
            index += character.len_utf8();
        }
        if index - start <= MAX_URL_LENGTH {
            let candidate = trim_url_punctuation(&text[start..index]);
            if candidate.len() > scheme_length {
                urls.push(candidate.to_string());
            }
        }
    }
    urls
}

fn starts_with_ascii_case(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.len() >= needle.len() && haystack[..needle.len()].eq_ignore_ascii_case(needle)
}

fn trim_url_punctuation(mut value: &str) -> &str {
    value = value.trim_end_matches(['.', ',', ';']);
    for (open, close) in [('(', ')'), ('[', ']'), ('{', '}')] {
        while value.ends_with(close)
            && value.chars().filter(|char| *char == close).count()
                > value.chars().filter(|char| *char == open).count()
        {
            value = &value[..value.len() - close.len_utf8()];
        }
    }
    value
}

fn parse_candidate(candidate: &str) -> Option<(Url, String)> {
    let original = trim_url_punctuation(candidate.trim()).to_string();
    if original.is_empty() || original.len() > MAX_URL_LENGTH {
        return None;
    }
    let parsed = match Url::parse(&original) {
        Ok(parsed) => parsed,
        Err(url::ParseError::RelativeUrlWithoutBase) if looks_like_bare_host_url(&original) => {
            Url::parse(&format!("https://{original}")).ok()?
        }
        Err(_) => return None,
    };
    matches!(parsed.scheme(), "http" | "https").then_some((parsed, original))
}

fn looks_like_bare_host_url(value: &str) -> bool {
    let authority = value.split(['/', '?', '#']).next().unwrap_or_default();
    !authority.is_empty()
        && !authority.chars().any(char::is_whitespace)
        && authority
            .rsplit_once('.')
            .is_some_and(|(name, suffix)| !name.is_empty() && suffix.len() >= 2)
}

#[cfg(test)]
mod tests {
    use super::{
        extract_http_urls, matching_blocked_host, parse_candidate, read_messaging_urls,
        utf16_slice, MessagingMediaFilter,
    };
    use crate::args::Args;
    use crate::corpus::{LinkClass, LinkPresentation};
    use crate::public_suffix::PublicSuffixList;
    use clap::Parser;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::collections::HashSet;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::Path;
    use std::sync::Mutex;
    use tar::{Builder, Header};
    use zip::write::SimpleFileOptions;

    #[test]
    fn extracts_urls_and_trims_chat_punctuation() {
        assert_eq!(
            extract_http_urls("see <https://example.com/a>, [image](https://i.imgur.com/x.png)."),
            vec![
                "https://example.com/a".to_string(),
                "https://i.imgur.com/x.png".to_string()
            ]
        );
    }

    #[test]
    fn blocks_subdomains_without_blocking_lookalikes() {
        let blocked = HashSet::from(["giphy.com".to_string()]);
        assert_eq!(
            matching_blocked_host("media.giphy.com", &blocked),
            Some("giphy.com")
        );
        assert_eq!(matching_blocked_host("notgiphy.com", &blocked), None);
    }

    #[test]
    fn slices_telegram_utf16_entity_offsets() {
        let text = "😀 visit example.com/a";
        assert_eq!(utf16_slice(text, 9, 13).as_deref(), Some("example.com/a"));
    }

    #[test]
    fn normalizes_bare_telegram_link_entities_to_https() {
        let (url, original) = parse_candidate("example.org/path?q=1").unwrap();
        assert_eq!(url.as_str(), "https://example.org/path?q=1");
        assert_eq!(original, "example.org/path?q=1");
        assert!(parse_candidate("not-a-link").is_none());
    }

    #[test]
    fn streams_all_supported_formats_without_retaining_messages() {
        let temp = tempfile::tempdir().unwrap();
        write_discord_fixture(temp.path());
        write_tgdataset_fixture(temp.path());
        write_disco_fixture(temp.path());
        write_telegram_fixture(temp.path());
        write_whatsapp_fixture(temp.path());

        let args = test_args(temp.path());
        let suffixes = PublicSuffixList::from_text("com\norg\nsc\n");
        let records = Mutex::new(Vec::new());
        let summary = read_messaging_urls(temp.path(), &args, &suffixes, |record| {
            records.lock().unwrap().push(record);
            Ok(())
        })
        .unwrap();
        let records = records.into_inner().unwrap();

        assert_eq!(summary.input_files, 5);
        assert_eq!(summary.recoverable_failures, 5);
        assert_eq!(summary.failed_inputs, 0);
        assert_eq!(summary.failed_members, 3);
        assert_eq!(summary.failed_records, 2);
        assert_eq!(summary.messages_seen, 12);
        assert_eq!(summary.malformed_messages, 2);
        assert_eq!(summary.bot_messages_skipped, 1);
        assert_eq!(summary.candidates_seen, 14);
        assert_eq!(summary.accepted_urls, 9);
        assert_eq!(summary.filtered_urls, 5);
        assert_eq!(summary.filtered_hosts["tenor.com"], 1);
        assert_eq!(summary.filtered_hosts["imgur.com"], 1);
        assert_eq!(summary.filtered_hosts["giphy.com"], 1);
        assert_eq!(summary.filtered_hosts["prnt.sc"], 1);
        assert_eq!(summary.filtered_hosts["bit.ly"], 1);
        assert_eq!(records.len(), 9);
        assert!(records
            .iter()
            .any(|record| record.url == "https://truncated.example.com/"));
        assert!(records
            .iter()
            .any(|record| record.url == "https://example.com/sample"));
        assert_eq!(
            records
                .iter()
                .filter(|record| record.link_class == LinkClass::ForwardedMessage)
                .count(),
            1
        );
        assert!(records.iter().all(|record| record.source_url.is_none()));
        assert!(records
            .iter()
            .all(|record| record.dataset != crate::corpus::Dataset::Generic));
        let masked = records
            .iter()
            .find(|record| record.url == "https://masked.example.com/story")
            .unwrap();
        assert_eq!(masked.link_presentation, LinkPresentation::Masked);
        assert_eq!(masked.analysis_weight, 0);
        assert!(masked.display_text.is_none());
        assert!(records
            .iter()
            .filter(|record| record.link_presentation != LinkPresentation::Masked)
            .all(|record| record
                .display_text
                .as_deref()
                .is_some_and(|text| text.starts_with("http"))));
        assert!(!records.iter().any(|record| {
            record.url.contains("tenor")
                || record.url.contains("giphy")
                || record.url.contains("imgur")
                || record.url.contains("prnt.sc")
                || record.url.contains("bot.example")
        }));
    }

    #[test]
    fn continues_with_later_inputs_after_an_archive_fails() {
        let temp = tempfile::tempdir().unwrap();
        let disco = temp.path().join("corpora/disco");
        fs::create_dir_all(&disco).unwrap();
        fs::write(disco.join("DISCO-corrupt.zip"), b"not a zip archive").unwrap();
        write_whatsapp_fixture(temp.path());

        let args = test_args(temp.path());
        let suffixes = PublicSuffixList::from_text("com\nsc\n");
        let records = Mutex::new(Vec::new());
        let summary = read_messaging_urls(temp.path(), &args, &suffixes, |record| {
            records.lock().unwrap().push(record);
            Ok(())
        })
        .unwrap();

        assert_eq!(summary.input_files, 2);
        assert_eq!(summary.failed_inputs, 1);
        assert_eq!(summary.failed_records, 1);
        assert!(summary.failures.iter().any(|failure| {
            failure.dataset == "disco"
                && failure.scope == "input"
                && failure.input.ends_with("DISCO-corrupt.zip")
        }));
        assert!(records
            .into_inner()
            .unwrap()
            .iter()
            .any(|record| record.url == "https://example.com/wa"));
    }

    #[test]
    fn output_sink_failures_remain_fatal() {
        let temp = tempfile::tempdir().unwrap();
        write_whatsapp_fixture(temp.path());

        let args = test_args(temp.path());
        let suffixes = PublicSuffixList::from_text("com\nsc\n");
        let error = read_messaging_urls(temp.path(), &args, &suffixes, |_| {
            Err("simulated disk full".to_string())
        })
        .unwrap_err();

        assert!(error.contains("output sink failed"));
        assert!(error.contains("simulated disk full"));
    }

    fn test_args(root: &Path) -> Args {
        let mut args = Args::parse_from([
            "urltrainer",
            root.to_str().unwrap(),
            "--format",
            "messaging-archives",
        ]);
        args.messaging_media_filter = MessagingMediaFilter::Expanded;
        args
    }

    fn append_tar_file<W: Write>(builder: &mut Builder<W>, path: &str, bytes: &[u8]) {
        let mut header = Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        builder.append_data(&mut header, path, bytes).unwrap();
    }

    fn write_discord_fixture(root: &Path) {
        let directory = root.join("corpora/discord-unveiled/raw-restricted");
        fs::create_dir_all(&directory).unwrap();
        let file = File::create(directory.join("dataset.zst")).unwrap();
        let encoder = zstd::stream::write::Encoder::new(file, 1).unwrap();
        let mut archive = Builder::new(encoder);
        append_tar_file(
            &mut archive,
            "guild.json",
            br#"{"content":"human https://example.com/discord https://media.tenor.com/a.gif","is_bot":false}
{"content":"truncated"
{"content":"human https://example.com/after-malformed","is_bot":false}
{"content":"https://bot.example.com/noise","is_bot":true}
"#,
        );
        let encoder = archive.into_inner().unwrap();
        encoder.finish().unwrap();
    }

    fn write_tgdataset_fixture(root: &Path) {
        let directory = root.join("corpora/tgdataset");
        fs::create_dir_all(&directory).unwrap();
        let file = File::create(directory.join("TGDataset_1.tar.gz")).unwrap();
        let gzip = GzEncoder::new(file, Compression::fast());
        let mut archive = Builder::new(gzip);
        append_tar_file(&mut archive, "public_db/00-truncated.json", b"{");
        append_tar_file(
            &mut archive,
            "public_db/01-valid.json",
            br#"{"1":{"username":"channel","text_messages":{"1":{"message":"https://example.org/tg https://bit.ly/opaque","is_forwarded":false},"2":{"message":"https://forwarded.example.com/a","is_forwarded":true}}}}"#,
        );
        let gzip = archive.into_inner().unwrap();
        gzip.finish().unwrap();
    }

    fn write_disco_fixture(root: &Path) {
        let directory = root.join("corpora/disco");
        fs::create_dir_all(&directory).unwrap();
        let file = File::create(directory.join("DISCO-fixture.zip")).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("data/00-broken/messages.xml", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(br#"<discord><message><text><</text></message></discord>"#)
            .unwrap();
        archive
            .start_file("data/01-valid/messages.xml", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(
                br#"<discord><message><text>https://example.com/disco &amp; https://i.imgur.com/a.png</text></message></discord>"#,
            )
            .unwrap();
        archive.finish().unwrap();
    }

    fn write_telegram_fixture(root: &Path) {
        let directory = root.join("corpora/telegram-groupverse");
        fs::create_dir_all(&directory).unwrap();
        let file = File::create(directory.join("sample.zip")).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("sample/00-truncated.json", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(br#"[{"message":"https://truncated.example.com","entities":[]}"#)
            .unwrap();
        archive
            .start_file("sample/01-valid.json", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(
                br#"[{"message":"https://example.com/sample","entities":[{"_":"MessageEntityTextUrl","offset":0,"length":4,"url":"https://giphy.com/gifs/a"},{"_":"MessageEntityTextUrl","offset":0,"length":4,"url":"https://masked.example.com/story"}],"fwd_from":null}]"#,
            )
            .unwrap();
        archive.finish().unwrap();
    }

    fn write_whatsapp_fixture(root: &Path) {
        let directory = root.join("corpora/whatsapp-public-groups");
        fs::create_dir_all(&directory).unwrap();
        let mut file = File::create(directory.join("anonymised_data_to_share.tsv")).unwrap();
        file.write_all(b"media_url\nhttps://example.com/wa\n")
            .unwrap();
        file.write_all(b"https://invalid.example/\xff\n").unwrap();
        file.write_all(b"https://prnt.sc/screenshot\n").unwrap();
    }
}
