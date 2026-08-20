use crate::args::ReportArgs;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

type SparseCounts = Vec<(u16, u64)>;

const STRUCTURAL_STATES: usize = 16;
const GENERIC_LEADS: usize = 1;
const ASCII_BASE: usize = 81;
const ASCII_FRAGMENT_BASE: usize = 82;
const CJK_BASE: usize = 20_992;
const CJK_FRAGMENT_BASE: usize = 20_993;
const FIXED_ASCII_SUFFIXES: [&str; 3] = ["com", "net", "org"];
// Legacy schema-v1 cubes have generic term rows synthesized from host positions. Keep a
// bounded reserve beyond the requested dictionary size so filtering those rows does not
// leave the report artificially short without requiring a corpus rescan.
const PAYLOAD_TERM_OVERSCAN: usize = 16;
const COMMON_LITERAL_ALPHABET: &str =
    "abcdefghijklmnopqrstuvwxyz0123456789-._/?&=:@+%#ABCDEFGHIJKLMNOPQRSTUVWXYZ~!$'()*,;";
const EXCLUDED_HOSTS: [&str; 31] = [
    "amzn.to",
    "bit.ly",
    "bl.ink",
    "buff.ly",
    "clck.ru",
    "cutt.ly",
    "dlvr.it",
    "fb.me",
    "goo.gl",
    "ift.tt",
    "is.gd",
    "j.mp",
    "lnkd.in",
    "ow.ly",
    "rb.gy",
    "rebrand.ly",
    "s.id",
    "short.io",
    "shorturl.at",
    "soo.gd",
    "t.co",
    "t.ly",
    "t.me",
    "tiny.cc",
    "tiny.one",
    "tinyurl.com",
    "trib.al",
    "urlz.fr",
    "v.gd",
    "wa.me",
    "youtu.be",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CubeMetadata {
    schema_version: u64,
    collection: String,
    datasets: Vec<String>,
    dataset_families: Vec<String>,
    contexts: Vec<String>,
    default_dataset_weights: Vec<f64>,
    default_context_weights: Vec<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCubeRow {
    #[serde(rename = "type")]
    kind: String,
    key: Option<String>,
    host: Option<String>,
    pattern_kind: Option<String>,
    term: Option<String>,
    counts: Option<SparseCounts>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum RowKind {
    Totals,
    Suffix,
    Host,
    Source,
    Term,
    HostPattern,
    Character,
}

impl RowKind {
    fn rank(self) -> u8 {
        match self {
            Self::Totals => 0,
            Self::Suffix => 1,
            Self::Host => 2,
            Self::Source => 3,
            Self::Term => 4,
            Self::HostPattern => 5,
            Self::Character => 6,
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "totals" => Some(Self::Totals),
            "suffix" => Some(Self::Suffix),
            "host" => Some(Self::Host),
            "source" => Some(Self::Source),
            "term" => Some(Self::Term),
            "host-pattern" => Some(Self::HostPattern),
            "character" => Some(Self::Character),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
struct CubeItem {
    kind: RowKind,
    key: String,
    counts: SparseCounts,
}

struct CubeCursor {
    path: PathBuf,
    reader: BufReader<Box<dyn Read>>,
    line: String,
    current: Option<CubeItem>,
    metadata: CubeMetadata,
}

impl CubeCursor {
    fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let input: Box<dyn Read> = if path.extension().is_some_and(|extension| extension == "gz") {
            Box::new(GzDecoder::new(file))
        } else {
            Box::new(file)
        };
        let mut reader = BufReader::new(input);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let metadata: CubeMetadata = serde_json::from_str(&line)
            .map_err(|error| format!("{} metadata: {error}", path.display()))?;
        if metadata.schema_version != 1 {
            return Err(format!(
                "unsupported cube schema {} in {}",
                metadata.schema_version,
                path.display()
            ));
        }
        let mut cursor = Self {
            path: path.to_path_buf(),
            reader,
            line: String::new(),
            current: None,
            metadata,
        };
        cursor.advance()?;
        Ok(cursor)
    }

    fn advance(&mut self) -> Result<(), String> {
        loop {
            self.line.clear();
            if self
                .reader
                .read_line(&mut self.line)
                .map_err(|error| format!("{}: {error}", self.path.display()))?
                == 0
            {
                self.current = None;
                return Ok(());
            }
            if self.line.trim().is_empty() {
                continue;
            }
            let row: RawCubeRow = serde_json::from_str(&self.line)
                .map_err(|error| format!("{} cube row: {error}", self.path.display()))?;
            let Some(kind) = RowKind::parse(&row.kind) else {
                continue;
            };
            let Some(counts) = row.counts else {
                return Err(format!(
                    "cube row without counts in {}",
                    self.path.display()
                ));
            };
            let key = if kind == RowKind::Totals {
                String::new()
            } else if kind == RowKind::HostPattern {
                format!(
                    "{}\t{}\t{}",
                    row.host
                        .ok_or_else(|| "host-pattern without host".to_string())?,
                    row.pattern_kind
                        .ok_or_else(|| "host-pattern without patternKind".to_string())?,
                    row.term
                        .ok_or_else(|| "host-pattern without term".to_string())?
                )
            } else {
                row.key
                    .ok_or_else(|| format!("{} row without key", row.kind))?
            };
            self.current = Some(CubeItem { kind, key, counts });
            return Ok(());
        }
    }
}

#[derive(Clone, Debug)]
struct Aggregate {
    key: String,
    counts: SparseCounts,
    raw_count: u64,
    weighted_count: f64,
    by_dataset: Vec<u64>,
    by_context: Vec<u64>,
}

#[derive(Clone, Debug)]
struct Weights {
    datasets: Vec<f64>,
    contexts: Vec<f64>,
    families: Vec<String>,
    family_weights: Vec<f64>,
    dataset_family_indexes: Vec<usize>,
}

#[derive(Clone, Debug)]
struct HeaderCandidate {
    aggregate: Aggregate,
    kind: &'static str,
    removed_characters: usize,
    tier_scores: [f64; 3],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComparisonEntry {
    key: String,
    raw_count: u64,
    score: f64,
}

#[derive(Default)]
struct ComparisonBuckets {
    host: Vec<ComparisonEntry>,
    suffix: Vec<ComparisonEntry>,
    term: Vec<ComparisonEntry>,
    source: Vec<ComparisonEntry>,
}

impl ComparisonBuckets {
    fn get_mut(&mut self, kind: RowKind) -> Option<&mut Vec<ComparisonEntry>> {
        match kind {
            RowKind::Host => Some(&mut self.host),
            RowKind::Suffix => Some(&mut self.suffix),
            RowKind::Term => Some(&mut self.term),
            RowKind::Source => Some(&mut self.source),
            _ => None,
        }
    }

    fn into_json(mut self, limit: usize) -> Value {
        for rows in [
            &mut self.host,
            &mut self.suffix,
            &mut self.term,
            &mut self.source,
        ] {
            sort_comparison(rows);
            rows.truncate(limit);
        }
        json!({
            "host": self.host,
            "suffix": self.suffix,
            "term": self.term,
            "source": self.source,
        })
    }
}

struct ComparisonCollector {
    datasets: Vec<ComparisonBuckets>,
    families: Vec<ComparisonBuckets>,
    limit: usize,
}

impl ComparisonCollector {
    fn new(metadata: &CubeMetadata, weights: &Weights, limit: usize) -> Self {
        Self {
            datasets: (0..metadata.datasets.len())
                .map(|_| ComparisonBuckets::default())
                .collect(),
            families: (0..weights.families.len())
                .map(|_| ComparisonBuckets::default())
                .collect(),
            limit,
        }
    }

    fn add(
        &mut self,
        kind: RowKind,
        aggregate: &Aggregate,
        metadata: &CubeMetadata,
        weights: &Weights,
    ) {
        if !matches!(
            kind,
            RowKind::Host | RowKind::Suffix | RowKind::Term | RowKind::Source
        ) {
            return;
        }
        let mut dataset_raw = vec![0_u64; metadata.datasets.len()];
        let mut dataset_score = vec![0_f64; metadata.datasets.len()];
        let mut family_raw = vec![0_u64; weights.families.len()];
        let mut family_score = vec![0_f64; weights.families.len()];
        for &(signal, count) in &aggregate.counts {
            let dataset = signal as usize / metadata.contexts.len();
            let context = signal as usize % metadata.contexts.len();
            let family = weights.dataset_family_indexes[dataset];
            let score = count as f64 * weights.datasets[dataset] * weights.contexts[context];
            dataset_raw[dataset] += count;
            dataset_score[dataset] += score;
            family_raw[family] += count;
            family_score[family] += score;
        }
        for dataset in 0..dataset_raw.len() {
            if dataset_raw[dataset] == 0 {
                continue;
            }
            let row = ComparisonEntry {
                key: aggregate.key.clone(),
                raw_count: dataset_raw[dataset],
                score: dataset_score[dataset],
            };
            push_bounded(
                self.datasets[dataset].get_mut(kind).unwrap(),
                row,
                self.limit,
                sort_comparison,
            );
        }
        for family in 0..family_raw.len() {
            if family_raw[family] == 0 {
                continue;
            }
            let row = ComparisonEntry {
                key: aggregate.key.clone(),
                raw_count: family_raw[family],
                score: family_score[family],
            };
            push_bounded(
                self.families[family].get_mut(kind).unwrap(),
                row,
                self.limit,
                sort_comparison,
            );
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostTotal {
    #[serde(rename = "host")]
    key: String,
    raw_count: u64,
    weighted_count: f64,
}

struct HostLookup {
    reader: BufReader<File>,
    line: String,
    current: Option<HostTotal>,
}

impl HostLookup {
    fn open(path: &Path) -> Result<Self, String> {
        let mut lookup = Self {
            reader: BufReader::new(File::open(path).map_err(|error| error.to_string())?),
            line: String::new(),
            current: None,
        };
        lookup.advance()?;
        Ok(lookup)
    }

    fn advance(&mut self) -> Result<(), String> {
        self.line.clear();
        if self
            .reader
            .read_line(&mut self.line)
            .map_err(|error| error.to_string())?
            == 0
        {
            self.current = None;
        } else {
            self.current =
                Some(serde_json::from_str(&self.line).map_err(|error| error.to_string())?);
        }
        Ok(())
    }

    fn find(&mut self, key: &str) -> Result<Option<HostTotal>, String> {
        while self
            .current
            .as_ref()
            .is_some_and(|current| current.key.as_str() < key)
        {
            self.advance()?;
        }
        Ok(self
            .current
            .as_ref()
            .filter(|current| current.key == key)
            .cloned())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PatternReport {
    key: String,
    host: String,
    pattern_kind: String,
    term: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    combined_token: Option<String>,
    raw_count: u64,
    weighted_count: f64,
    top_datasets: Value,
    top_contexts: Value,
    raw_host_urls: u64,
    weighted_host_urls: f64,
    raw_host_coverage: f64,
    raw_host_coverage_lower_bound95: f64,
    weighted_host_coverage: f64,
    tail_bits_per_use: usize,
    estimated_tail_bits_saved: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    combined_bits_per_use: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    estimated_combined_bits_saved: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostPatternSummary {
    host: String,
    raw_urls: u64,
    weighted_urls: f64,
    top_by_coverage: Vec<PatternReport>,
    top_by_savings: Vec<PatternReport>,
}

struct PatternGroup {
    host: String,
    total: HostTotal,
    top_coverage: Vec<PatternReport>,
    top_savings: Vec<PatternReport>,
}

struct PatternIdentity {
    host: String,
    pattern_kind: String,
    term: String,
}

struct Collected {
    totals: SparseCounts,
    header_candidates: Vec<HeaderCandidate>,
    eligible_header_candidates: usize,
    distinct_hosts: usize,
    distinct_suffixes: usize,
    characters: Vec<Aggregate>,
    terms: Vec<Aggregate>,
    comparison: ComparisonCollector,
    patterns: Vec<PatternReport>,
    pattern_hosts: Vec<HostPatternSummary>,
}

pub fn generate(args: ReportArgs) -> Result<(), String> {
    validate_args(&args)?;
    std::fs::create_dir_all(&args.out_dir).map_err(|error| error.to_string())?;
    let mut cursors = args
        .cubes
        .iter()
        .map(|path| CubeCursor::open(path))
        .collect::<Result<Vec<_>, _>>()?;
    let metadata = cursors
        .first()
        .ok_or_else(|| "--cubes requires at least one cube".to_string())?
        .metadata
        .clone();
    for cursor in cursors.iter().skip(1) {
        assert_compatible_metadata(&metadata, &cursor.metadata, &cursor.path)?;
    }
    let collections = cursors
        .iter()
        .map(|cursor| cursor.metadata.collection.clone())
        .collect::<Vec<_>>();
    let weights = configure_weights(&metadata, &args)?;
    let host_spool_path = args
        .out_dir
        .join(format!(".host-totals-{}.tmp.jsonl", std::process::id()));
    let host_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&host_spool_path)
        .map_err(|error| format!("{}: {error}", host_spool_path.display()))?;
    let mut host_writer = Some(BufWriter::new(host_file));
    let mut host_lookup: Option<HostLookup> = None;
    let mut pattern_group: Option<PatternGroup> = None;
    let mut collected = Collected {
        totals: Vec::new(),
        header_candidates: Vec::new(),
        eligible_header_candidates: 0,
        distinct_hosts: 0,
        distinct_suffixes: 0,
        characters: Vec::new(),
        terms: Vec::new(),
        comparison: ComparisonCollector::new(&metadata, &weights, args.comparison_limit),
        patterns: Vec::new(),
        pattern_hosts: Vec::new(),
    };

    let result = stream_merged_rows(&mut cursors, |item| {
        let aggregate = summarize(item.key, item.counts, &metadata, &weights)?;
        collected
            .comparison
            .add(item.kind, &aggregate, &metadata, &weights);
        match item.kind {
            RowKind::Totals => collected.totals = aggregate.counts,
            RowKind::Suffix => {
                collected.distinct_suffixes += 1;
                add_header_candidate(&mut collected, aggregate, "suffix", &args);
            }
            RowKind::Host => {
                collected.distinct_hosts += 1;
                let host_total = HostTotal {
                    key: aggregate.key.clone(),
                    raw_count: aggregate.raw_count,
                    weighted_count: aggregate.weighted_count,
                };
                serde_json::to_writer(host_writer.as_mut().unwrap(), &host_total)
                    .map_err(|error| error.to_string())?;
                host_writer
                    .as_mut()
                    .unwrap()
                    .write_all(b"\n")
                    .map_err(|error| error.to_string())?;
                if !EXCLUDED_HOSTS.contains(&aggregate.key.to_ascii_lowercase().as_str()) {
                    add_header_candidate(&mut collected, aggregate, "host", &args);
                }
            }
            RowKind::Source => {}
            RowKind::Term => {
                let savings = aggregate.weighted_count
                    * literal_savings(&aggregate.key, args.token_cost_bits) as f64;
                if savings > 0.0 {
                    push_bounded(
                        &mut collected.terms,
                        aggregate,
                        args.term_limit.saturating_mul(PAYLOAD_TERM_OVERSCAN),
                        |rows| {
                            rows.sort_by(|left, right| {
                                compare_term(left, right, args.token_cost_bits)
                            });
                        },
                    );
                }
            }
            RowKind::Character => {
                if aggregate.key.chars().count() == 1 {
                    push_bounded(
                        &mut collected.characters,
                        aggregate,
                        args.symbol_limit,
                        |rows| {
                            rows.sort_by(compare_character);
                        },
                    );
                }
            }
            RowKind::HostPattern => {
                if host_lookup.is_none() {
                    let mut writer = host_writer.take().unwrap();
                    writer.flush().map_err(|error| error.to_string())?;
                    drop(writer);
                    host_lookup = Some(HostLookup::open(&host_spool_path)?);
                }
                let identity = split_pattern_key(&aggregate.key)?;
                if pattern_group
                    .as_ref()
                    .is_some_and(|group| group.host != identity.host)
                {
                    finish_pattern_group(&mut collected, pattern_group.take().unwrap(), &args);
                }
                if pattern_group.is_none() {
                    let total = host_lookup
                        .as_mut()
                        .unwrap()
                        .find(&identity.host)?
                        .unwrap_or(HostTotal {
                            key: identity.host.clone(),
                            raw_count: 0,
                            weighted_count: 0.0,
                        });
                    pattern_group = Some(PatternGroup {
                        host: identity.host.clone(),
                        total,
                        top_coverage: Vec::new(),
                        top_savings: Vec::new(),
                    });
                }
                if let Some(report) = pattern_report(
                    aggregate,
                    &identity,
                    pattern_group.as_ref().unwrap().total.clone(),
                    &metadata,
                    &weights,
                    &args,
                ) {
                    push_bounded(
                        &mut collected.patterns,
                        report.clone(),
                        args.host_pattern_limit,
                        sort_patterns,
                    );
                    push_bounded(
                        &mut pattern_group.as_mut().unwrap().top_coverage,
                        report.clone(),
                        args.host_patterns_per_host,
                        sort_patterns_by_coverage,
                    );
                    push_bounded(
                        &mut pattern_group.as_mut().unwrap().top_savings,
                        report,
                        args.host_patterns_per_host,
                        sort_patterns_by_savings,
                    );
                }
            }
        }
        Ok(())
    });
    if let Some(group) = pattern_group.take() {
        finish_pattern_group(&mut collected, group, &args);
    }
    drop(host_writer);
    drop(host_lookup);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&host_spool_path);
        return Err(error);
    }
    let hosts_path = args.out_dir.join("hosts.jsonl");
    if hosts_path.exists() {
        std::fs::remove_file(&hosts_path)
            .map_err(|error| format!("{}: {error}", hosts_path.display()))?;
    }
    std::fs::rename(&host_spool_path, &hosts_path).map_err(|error| {
        format!(
            "{} -> {}: {error}",
            host_spool_path.display(),
            hosts_path.display()
        )
    })?;

    finalize_collected(&mut collected, &args);
    write_outputs(&args, &metadata, &weights, &collections, collected)?;
    Ok(())
}

fn validate_args(args: &ReportArgs) -> Result<(), String> {
    if args.cubes.is_empty() {
        return Err("--cubes requires at least one path".to_string());
    }
    for path in &args.cubes {
        if !path.is_file() {
            return Err(format!("cube is unavailable: {}", path.display()));
        }
    }
    for (name, value) in [
        ("symbol-limit", args.symbol_limit),
        ("term-limit", args.term_limit),
        ("host-pattern-limit", args.host_pattern_limit),
        ("host-pattern-host-limit", args.host_pattern_host_limit),
        ("host-patterns-per-host", args.host_patterns_per_host),
        ("comparison-limit", args.comparison_limit),
        ("header-candidate-limit", args.header_candidate_limit),
        ("header-curve-rows", args.header_curve_rows),
    ] {
        if value == 0 {
            return Err(format!("--{name} must be positive"));
        }
    }
    Ok(())
}

fn assert_compatible_metadata(
    left: &CubeMetadata,
    right: &CubeMetadata,
    path: &Path,
) -> Result<(), String> {
    if left.datasets != right.datasets {
        return Err(format!(
            "incompatible datasets dimension in {}",
            path.display()
        ));
    }
    if left.dataset_families != right.dataset_families {
        return Err(format!(
            "incompatible datasetFamilies dimension in {}",
            path.display()
        ));
    }
    if left.contexts != right.contexts {
        return Err(format!(
            "incompatible contexts dimension in {}",
            path.display()
        ));
    }
    Ok(())
}

fn stream_merged_rows<F>(cursors: &mut [CubeCursor], mut handle: F) -> Result<(), String>
where
    F: FnMut(CubeItem) -> Result<(), String>,
{
    loop {
        let minimum = cursors
            .iter()
            .filter_map(|cursor| cursor.current.as_ref())
            .min_by(|left, right| compare_cube_items(left, right))
            .map(|item| (item.kind, item.key.clone()));
        let Some((kind, key)) = minimum else {
            return Ok(());
        };
        let maximum_signal = cursors
            .iter()
            .filter_map(|cursor| cursor.current.as_ref())
            .flat_map(|item| item.counts.iter().map(|(signal, _)| *signal as usize))
            .max()
            .unwrap_or(0);
        let mut dense = vec![0_u64; maximum_signal + 1];
        for cursor in cursors.iter_mut() {
            let matches = cursor
                .current
                .as_ref()
                .is_some_and(|item| item.kind == kind && item.key == key);
            if !matches {
                continue;
            }
            for &(signal, count) in &cursor.current.as_ref().unwrap().counts {
                dense[signal as usize] = dense[signal as usize].saturating_add(count);
            }
            cursor.advance()?;
        }
        let counts = dense
            .into_iter()
            .enumerate()
            .filter_map(|(signal, count)| (count != 0).then_some((signal as u16, count)))
            .collect();
        handle(CubeItem { kind, key, counts })?;
    }
}

fn compare_cube_items(left: &CubeItem, right: &CubeItem) -> Ordering {
    left.kind
        .rank()
        .cmp(&right.kind.rank())
        .then_with(|| left.key.cmp(&right.key))
}

fn configure_weights(metadata: &CubeMetadata, args: &ReportArgs) -> Result<Weights, String> {
    let mut families = Vec::new();
    for family in &metadata.dataset_families {
        if !families.contains(family) {
            families.push(family.clone());
        }
    }
    let family_weights = configured_weights(
        &families,
        &vec![1.0; families.len()],
        args.family_weights.as_deref(),
        "family",
    )?;
    let base_dataset_weights = configured_weights(
        &metadata.datasets,
        &metadata.default_dataset_weights,
        args.dataset_weights.as_deref(),
        "dataset",
    )?;
    let dataset_family_indexes = metadata
        .dataset_families
        .iter()
        .map(|family| {
            families
                .iter()
                .position(|candidate| candidate == family)
                .unwrap()
        })
        .collect::<Vec<_>>();
    let datasets = base_dataset_weights
        .iter()
        .enumerate()
        .map(|(index, weight)| weight * family_weights[dataset_family_indexes[index]])
        .collect();
    let contexts = configured_weights(
        &metadata.contexts,
        &metadata.default_context_weights,
        args.context_weights.as_deref(),
        "context",
    )?;
    Ok(Weights {
        datasets,
        contexts,
        families,
        family_weights,
        dataset_family_indexes,
    })
}

fn configured_weights(
    names: &[String],
    defaults: &[f64],
    raw: Option<&str>,
    label: &str,
) -> Result<Vec<f64>, String> {
    let mut weights = defaults.to_vec();
    let Some(raw) = raw else {
        return Ok(weights);
    };
    for assignment in raw.split(',') {
        let Some((name, value)) = assignment.rsplit_once('=') else {
            return Err(format!("invalid {label} weight: {assignment}"));
        };
        let Some(index) = names.iter().position(|candidate| candidate == name.trim()) else {
            return Err(format!("invalid {label} weight: {assignment}"));
        };
        let value = value
            .trim()
            .parse::<f64>()
            .map_err(|_| format!("invalid {label} weight: {assignment}"))?;
        if !value.is_finite() || value < 0.0 {
            return Err(format!("invalid {label} weight: {assignment}"));
        }
        weights[index] = value;
    }
    Ok(weights)
}

fn summarize(
    key: String,
    counts: SparseCounts,
    metadata: &CubeMetadata,
    weights: &Weights,
) -> Result<Aggregate, String> {
    let mut by_dataset = vec![0_u64; metadata.datasets.len()];
    let mut by_context = vec![0_u64; metadata.contexts.len()];
    let mut raw_count = 0_u64;
    let mut weighted_count = 0_f64;
    for &(signal, count) in &counts {
        let dataset = signal as usize / metadata.contexts.len();
        let context = signal as usize % metadata.contexts.len();
        if dataset >= metadata.datasets.len() {
            return Err(format!("signal {signal} exceeds cube dimensions"));
        }
        raw_count = raw_count.saturating_add(count);
        by_dataset[dataset] = by_dataset[dataset].saturating_add(count);
        by_context[context] = by_context[context].saturating_add(count);
        weighted_count += count as f64 * weights.datasets[dataset] * weights.contexts[context];
    }
    Ok(Aggregate {
        key,
        counts,
        raw_count,
        weighted_count,
        by_dataset,
        by_context,
    })
}

fn add_header_candidate(
    collected: &mut Collected,
    aggregate: Aggregate,
    kind: &'static str,
    args: &ReportArgs,
) {
    if aggregate.weighted_count <= 0.0 {
        return;
    }
    collected.eligible_header_candidates += 1;
    let removed_characters = if kind == "host" {
        aggregate.key.chars().count()
    } else {
        aggregate.key.chars().count() + 1
    };
    let candidate = HeaderCandidate {
        tier_scores: [1, 2, 3].map(|length| {
            aggregate.weighted_count * removed_characters.saturating_sub(length - 1) as f64
        }),
        aggregate,
        kind,
        removed_characters,
    };
    push_bounded(
        &mut collected.header_candidates,
        candidate,
        args.header_candidate_limit,
        sort_header_candidates,
    );
}

fn split_pattern_key(key: &str) -> Result<PatternIdentity, String> {
    let mut fields = key.splitn(3, '\t');
    let host = fields
        .next()
        .ok_or_else(|| "host-pattern without host".to_string())?;
    let kind = fields
        .next()
        .ok_or_else(|| "host-pattern without kind".to_string())?;
    let term = fields
        .next()
        .ok_or_else(|| "host-pattern without term".to_string())?;
    Ok(PatternIdentity {
        host: host.to_string(),
        pattern_kind: kind.to_string(),
        term: term.to_string(),
    })
}

fn pattern_report(
    aggregate: Aggregate,
    identity: &PatternIdentity,
    host_total: HostTotal,
    metadata: &CubeMetadata,
    weights: &Weights,
    args: &ReportArgs,
) -> Option<PatternReport> {
    let tail_bits_per_use = literal_savings(&identity.term, args.token_cost_bits);
    let estimated_tail_bits_saved = aggregate.weighted_count * tail_bits_per_use as f64;
    if estimated_tail_bits_saved <= 0.0 || aggregate.raw_count < args.host_pattern_min_occurrences {
        return None;
    }
    let prefix = matches!(
        identity.pattern_kind.as_str(),
        "path-prefix" | "prefix-query"
    );
    let combined_token = prefix.then(|| format!("{}{}", identity.host, identity.term));
    let combined_bits_per_use = combined_token
        .as_deref()
        .map(|value| literal_savings(value, args.token_cost_bits));
    Some(PatternReport {
        key: format!(
            "{} {} {}",
            identity.host, identity.pattern_kind, identity.term
        ),
        host: identity.host.clone(),
        pattern_kind: identity.pattern_kind.clone(),
        term: identity.term.clone(),
        combined_token,
        raw_count: aggregate.raw_count,
        weighted_count: aggregate.weighted_count,
        top_datasets: top_dataset_contributions(&aggregate, metadata, weights, 5),
        top_contexts: top_context_contributions(&aggregate, metadata, weights, 5),
        raw_host_urls: host_total.raw_count,
        weighted_host_urls: host_total.weighted_count,
        raw_host_coverage: divide(aggregate.raw_count as f64, host_total.raw_count as f64),
        raw_host_coverage_lower_bound95: wilson_lower_bound(
            aggregate.raw_count,
            host_total.raw_count,
        ),
        weighted_host_coverage: divide(aggregate.weighted_count, host_total.weighted_count),
        tail_bits_per_use,
        estimated_tail_bits_saved,
        combined_bits_per_use,
        estimated_combined_bits_saved: combined_bits_per_use
            .map(|bits| aggregate.weighted_count * bits as f64),
    })
}

fn finish_pattern_group(collected: &mut Collected, mut group: PatternGroup, args: &ReportArgs) {
    if group.top_coverage.is_empty() {
        return;
    }
    sort_patterns_by_coverage(&mut group.top_coverage);
    sort_patterns_by_savings(&mut group.top_savings);
    group.top_coverage.truncate(args.host_patterns_per_host);
    group.top_savings.truncate(args.host_patterns_per_host);
    let summary = HostPatternSummary {
        host: group.host,
        raw_urls: group.total.raw_count,
        weighted_urls: group.total.weighted_count,
        top_by_coverage: group.top_coverage,
        top_by_savings: group.top_savings,
    };
    push_bounded(
        &mut collected.pattern_hosts,
        summary,
        args.host_pattern_host_limit,
        sort_pattern_hosts,
    );
}

fn finalize_collected(collected: &mut Collected, args: &ReportArgs) {
    sort_header_candidates(&mut collected.header_candidates);
    collected
        .header_candidates
        .truncate(args.header_candidate_limit);
    collected.characters.sort_by(compare_character);
    collected.characters.truncate(args.symbol_limit);
    collected
        .terms
        .sort_by(|left, right| compare_term(left, right, args.token_cost_bits));
    sort_patterns(&mut collected.patterns);
    collected.patterns.truncate(args.host_pattern_limit);
    sort_pattern_hosts(&mut collected.pattern_hosts);
    collected
        .pattern_hosts
        .truncate(args.host_pattern_host_limit);
}

fn push_bounded<T, F>(rows: &mut Vec<T>, row: T, limit: usize, sort: F)
where
    F: Fn(&mut [T]),
{
    rows.push(row);
    if rows.len() >= limit.saturating_mul(2).max(2) {
        sort(rows.as_mut_slice());
        rows.truncate(limit);
    }
}

fn compare_f64_desc(left: f64, right: f64) -> Ordering {
    right.partial_cmp(&left).unwrap_or(Ordering::Equal)
}

fn sort_header_candidates(rows: &mut [HeaderCandidate]) {
    rows.sort_by(|left, right| {
        compare_f64_desc(
            left.aggregate.weighted_count,
            right.aggregate.weighted_count,
        )
        .then_with(|| left.aggregate.key.cmp(&right.aggregate.key))
        .then_with(|| left.kind.cmp(right.kind))
    });
}

fn compare_character(left: &Aggregate, right: &Aggregate) -> Ordering {
    compare_f64_desc(left.weighted_count * 7.0, right.weighted_count * 7.0)
        .then_with(|| left.key.cmp(&right.key))
}

fn compare_term(left: &Aggregate, right: &Aggregate, token_cost_bits: usize) -> Ordering {
    let left_score = left.weighted_count * literal_savings(&left.key, token_cost_bits) as f64;
    let right_score = right.weighted_count * literal_savings(&right.key, token_cost_bits) as f64;
    compare_f64_desc(left_score, right_score).then_with(|| left.key.cmp(&right.key))
}

fn sort_comparison(rows: &mut [ComparisonEntry]) {
    rows.sort_by(|left, right| {
        compare_f64_desc(left.score, right.score)
            .then_with(|| right.raw_count.cmp(&left.raw_count))
            .then_with(|| left.key.cmp(&right.key))
    });
}

fn sort_patterns(rows: &mut [PatternReport]) {
    rows.sort_by(|left, right| {
        compare_f64_desc(
            left.estimated_tail_bits_saved,
            right.estimated_tail_bits_saved,
        )
        .then_with(|| compare_f64_desc(left.weighted_host_coverage, right.weighted_host_coverage))
        .then_with(|| left.host.cmp(&right.host))
        .then_with(|| left.term.cmp(&right.term))
    });
}

fn sort_patterns_by_coverage(rows: &mut [PatternReport]) {
    rows.sort_by(|left, right| {
        compare_f64_desc(
            left.raw_host_coverage_lower_bound95,
            right.raw_host_coverage_lower_bound95,
        )
        .then_with(|| compare_f64_desc(left.raw_host_coverage, right.raw_host_coverage))
        .then_with(|| right.raw_count.cmp(&left.raw_count))
        .then_with(|| left.term.cmp(&right.term))
    });
}

fn sort_patterns_by_savings(rows: &mut [PatternReport]) {
    rows.sort_by(|left, right| {
        compare_f64_desc(
            left.estimated_tail_bits_saved,
            right.estimated_tail_bits_saved,
        )
        .then_with(|| {
            compare_f64_desc(
                left.raw_host_coverage_lower_bound95,
                right.raw_host_coverage_lower_bound95,
            )
        })
        .then_with(|| left.term.cmp(&right.term))
    });
}

fn sort_pattern_hosts(rows: &mut [HostPatternSummary]) {
    rows.sort_by(|left, right| {
        compare_f64_desc(left.weighted_urls, right.weighted_urls)
            .then_with(|| right.raw_urls.cmp(&left.raw_urls))
            .then_with(|| left.host.cmp(&right.host))
    });
}

fn literal_bits(value: &str) -> usize {
    value
        .chars()
        .map(|character| {
            if COMMON_LITERAL_ALPHABET.contains(character) {
                6
            } else {
                13
            }
        })
        .sum()
}

fn literal_savings(value: &str, token_cost_bits: usize) -> usize {
    literal_bits(value).saturating_sub(token_cost_bits)
}

fn divide(numerator: f64, denominator: f64) -> f64 {
    if denominator == 0.0 {
        0.0
    } else {
        numerator / denominator
    }
}

fn wilson_lower_bound(successes: u64, total: u64) -> f64 {
    if successes == 0 || total == 0 {
        return 0.0;
    }
    let z = 1.959_963_984_540_054_f64;
    let probability = successes as f64 / total as f64;
    let z_squared = z * z;
    let denominator = 1.0 + z_squared / total as f64;
    let centre = probability + z_squared / (2.0 * total as f64);
    let margin = z
        * ((probability * (1.0 - probability) + z_squared / (4.0 * total as f64)) / total as f64)
            .sqrt();
    ((centre - margin) / denominator).max(0.0)
}

fn generated_at() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string())
}

// Output construction and header optimization are kept below the streaming seam: callers only
// provide immutable cubes, weights, and an output directory.

fn write_outputs(
    args: &ReportArgs,
    metadata: &CubeMetadata,
    weights: &Weights,
    collections: &[String],
    mut collected: Collected,
) -> Result<(), String> {
    let header_json_path = args.out_dir.join("header-shortlists.json");
    let header_markdown_path = args.out_dir.join("header-shortlists.md");
    let symbols_json_path = args.out_dir.join("common-symbols.json");
    let symbols_markdown_path = args.out_dir.join("common-symbols.md");
    let comparison_json_path = args.out_dir.join("source-comparison.json");
    let comparison_markdown_path = args.out_dir.join("source-comparison.md");
    let patterns_json_path = args.out_dir.join("host-patterns.json");
    let patterns_markdown_path = args.out_dir.join("host-patterns.md");
    let manifest_path = args.out_dir.join("report-manifest.json");

    let headers = build_headers(
        &collected.header_candidates,
        collected.eligible_header_candidates,
        collected.distinct_hosts,
        collected.distinct_suffixes,
        metadata,
        weights,
        args,
    )?;
    let (payload_terms, excluded_header_terms) =
        filter_header_resolved_terms(&collected.terms, &headers, args.term_limit);
    let symbols = build_common_symbols(
        &collected.characters,
        &payload_terms,
        excluded_header_terms,
        metadata,
        weights,
        args,
    );
    write_json(&symbols_json_path, &symbols)?;
    write_text(&symbols_markdown_path, &render_symbols_markdown(&symbols))?;
    eprintln!("wrote {}", symbols_json_path.display());
    eprintln!("wrote {}", symbols_markdown_path.display());

    let comparison = build_comparison(
        &collected.totals,
        std::mem::replace(
            &mut collected.comparison,
            ComparisonCollector::new(metadata, weights, args.comparison_limit),
        ),
        metadata,
        weights,
        args,
    )?;
    write_json(&comparison_json_path, &comparison)?;
    write_text(
        &comparison_markdown_path,
        &render_comparison_markdown(&comparison),
    )?;
    eprintln!("wrote {}", comparison_json_path.display());
    eprintln!("wrote {}", comparison_markdown_path.display());

    let patterns = build_host_patterns(
        &collected.patterns,
        &collected.pattern_hosts,
        metadata,
        weights,
        args,
    );
    write_json(&patterns_json_path, &patterns)?;
    write_text(
        &patterns_markdown_path,
        &render_patterns_markdown(&patterns),
    )?;
    eprintln!("wrote {}", patterns_json_path.display());
    eprintln!("wrote {}", patterns_markdown_path.display());

    write_json(&header_json_path, &headers)?;
    write_text(&header_markdown_path, &render_header_markdown(&headers))?;
    eprintln!("wrote {}", header_json_path.display());
    eprintln!("wrote {}", header_markdown_path.display());

    let outputs = json!({
        "headerJson": path_string(&header_json_path),
        "headerMarkdown": path_string(&header_markdown_path),
        "symbolsJson": path_string(&symbols_json_path),
        "symbolsMarkdown": path_string(&symbols_markdown_path),
        "comparisonJson": path_string(&comparison_json_path),
        "comparisonMarkdown": path_string(&comparison_markdown_path),
        "hostPatternsJson": path_string(&patterns_json_path),
        "hostPatternsMarkdown": path_string(&patterns_markdown_path),
        "hostsJsonl": path_string(&args.out_dir.join("hosts.jsonl")),
        "manifest": path_string(&manifest_path),
    });
    let family_weight_object = weights
        .families
        .iter()
        .cloned()
        .zip(weights.family_weights.iter().map(|weight| json!(weight)))
        .collect::<serde_json::Map<String, Value>>();
    let manifest = json!({
        "schemaVersion": 1,
        "generatedAt": generated_at(),
        "generator": "urltrainer report",
        "aggregation": "bounded k-way streaming merge",
        "rawCubes": args.cubes.iter().map(|path| path_string(path)).collect::<Vec<_>>(),
        "collections": collections,
        "dimensions": {
            "datasets": metadata.datasets,
            "datasetFamilies": metadata.dataset_families,
            "contexts": metadata.contexts,
        },
        "weights": {
            "families": family_weight_object,
            "datasets": named_weights(&metadata.datasets, &weights.datasets),
            "contexts": named_weights(&metadata.contexts, &weights.contexts),
        },
        "limits": {
            "headerCandidates": args.header_candidate_limit,
            "dictionaryTerms": args.term_limit,
            "hostPatterns": args.host_pattern_limit,
            "hostPatternHosts": args.host_pattern_host_limit,
            "comparisonRowsPerDimension": args.comparison_limit,
        },
        "outputs": outputs,
        "note": "Re-run this command with different weights; the raw cubes are immutable and no corpus rescan is required.",
    });
    write_json(&manifest_path, &manifest)?;
    eprintln!("wrote {}", manifest_path.display());
    Ok(())
}

fn build_common_symbols(
    characters: &[Aggregate],
    terms: &[Aggregate],
    excluded_header_terms: usize,
    metadata: &CubeMetadata,
    weights: &Weights,
    args: &ReportArgs,
) -> Value {
    let literal_characters = characters
        .iter()
        .map(|entry| {
            extend_object(
                aggregate_result(entry, metadata, weights),
                [("estimatedBitsSaved", json!(entry.weighted_count * 7.0))],
            )
        })
        .collect::<Vec<_>>();
    let dictionary_terms = terms
        .iter()
        .map(|entry| {
            let bits = literal_savings(&entry.key, args.token_cost_bits);
            extend_object(
                aggregate_result(entry, metadata, weights),
                [
                    ("bitsPerUse", json!(bits)),
                    (
                        "estimatedBitsSaved",
                        json!(entry.weighted_count * bits as f64),
                    ),
                ],
            )
        })
        .collect::<Vec<_>>();
    json!({
        "generatedAt": generated_at(),
        "objective": "Weighted occurrences multiplied by estimated literal bits avoided. Terms which a selected v2 header already resolves at the host/suffix position are excluded; path and query terms remain eligible.",
        "excludedHeaderResolvedTerms": excluded_header_terms,
        "dictionaryCandidateOverscan": PAYLOAD_TERM_OVERSCAN,
        "weights": weights_json(metadata, weights),
        "literalCharacterRankingPurpose": "Frequency evidence for internal token-code assignment only; carrier alphabets are fixed by codec mode.",
        "literalCharacters": literal_characters,
        "dictionaryTerms": dictionary_terms,
    })
}

/// Excludes legacy generic-term rows which were synthesized from the host suffix position.
///
/// Schema-v1 cubes did not retain term provenance, so this is deliberately narrow: only the
/// exact `.suffix` and `.suffix/` / `.suffix?` forms emitted by the former host-shape extractor
/// are removed, and only when that suffix is selected by at least one header mode. `www.` is
/// also removed because the structural header bit always resolves that exact host prefix. A
/// domain-like string from a real path/query position therefore remains a payload candidate.
fn filter_header_resolved_terms(
    terms: &[Aggregate],
    headers: &Value,
    limit: usize,
) -> (Vec<Aggregate>, usize) {
    let selected_suffixes = headers["modes"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|mode| {
            ["tier1", "tier2", "tier3"]
                .into_iter()
                .flat_map(move |tier| mode["best"][tier].as_array().into_iter().flatten())
        })
        .filter(|entry| entry["kind"].as_str() == Some("suffix"))
        .filter_map(|entry| entry["key"].as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut excluded = 0;
    let mut retained = Vec::with_capacity(limit);
    for term in terms {
        if term.key == "www." || is_header_resolved_suffix_term(&term.key, &selected_suffixes) {
            excluded += 1;
        } else if retained.len() < limit {
            retained.push(term.clone());
        }
    }
    (retained, excluded)
}

fn is_header_resolved_suffix_term(
    term: &str,
    selected_suffixes: &std::collections::HashSet<&str>,
) -> bool {
    let Some(suffix) = term.strip_prefix('.') else {
        return false;
    };
    let suffix = suffix
        .strip_suffix('/')
        .or_else(|| suffix.strip_suffix('?'))
        .unwrap_or(suffix);
    selected_suffixes.contains(suffix)
}

fn build_comparison(
    totals: &SparseCounts,
    comparison: ComparisonCollector,
    metadata: &CubeMetadata,
    weights: &Weights,
    args: &ReportArgs,
) -> Result<Value, String> {
    let totals = summarize("all".to_string(), totals.clone(), metadata, weights)?;
    let mut dataset_buckets = comparison.datasets.into_iter();
    let datasets = metadata
        .datasets
        .iter()
        .enumerate()
        .map(|(dataset, name)| {
            let context_weighted_score = totals
                .counts
                .iter()
                .filter(|(signal, _)| *signal as usize / metadata.contexts.len() == dataset)
                .map(|(signal, count)| {
                    *count as f64 * weights.contexts[*signal as usize % metadata.contexts.len()]
                })
                .sum::<f64>();
            json!({
                "name": name,
                "family": metadata.dataset_families[dataset],
                "rawUrls": totals.by_dataset[dataset],
                "datasetWeight": weights.datasets[dataset],
                "contextWeightedScore": context_weighted_score,
                "top": dataset_buckets.next().unwrap().into_json(args.comparison_limit),
            })
        })
        .collect::<Vec<_>>();
    let mut family_buckets = comparison.families.into_iter();
    let families = weights
        .families
        .iter()
        .enumerate()
        .map(|(family_index, family)| {
            let family_datasets = metadata
                .datasets
                .iter()
                .enumerate()
                .filter(|(index, _)| weights.dataset_family_indexes[*index] == family_index)
                .map(|(_, name)| name.clone())
                .collect::<Vec<_>>();
            let raw_urls = metadata
                .datasets
                .iter()
                .enumerate()
                .filter(|(index, _)| weights.dataset_family_indexes[*index] == family_index)
                .map(|(index, _)| totals.by_dataset[index])
                .sum::<u64>();
            let weighted_score = totals
                .counts
                .iter()
                .filter_map(|(signal, count)| {
                    let dataset = *signal as usize / metadata.contexts.len();
                    let context = *signal as usize % metadata.contexts.len();
                    (weights.dataset_family_indexes[dataset] == family_index).then_some(
                        *count as f64 * weights.datasets[dataset] * weights.contexts[context],
                    )
                })
                .sum::<f64>();
            json!({
                "name": family,
                "datasets": family_datasets,
                "rawUrls": raw_urls,
                "weightedScore": weighted_score,
                "top": family_buckets.next().unwrap().into_json(args.comparison_limit),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "generatedAt": generated_at(),
        "weights": weights_json(metadata, weights),
        "datasets": datasets,
        "families": families,
    }))
}

fn build_host_patterns(
    patterns: &[PatternReport],
    hosts: &[HostPatternSummary],
    metadata: &CubeMetadata,
    weights: &Weights,
    args: &ReportArgs,
) -> Value {
    json!({
        "generatedAt": generated_at(),
        "objective": "Host-conditioned structural frequency. Every pattern count is deduplicated per URL and divided by all retained URLs for that registrable host. Tail-token savings model a host header followed by a reusable route token; combined-token savings are shown only for patterns contiguous with the host.",
        "coverageNote": "Raw coverage is the empirical fraction. The 95% Wilson lower bound is used for coverage ranking so tiny hosts with 1/1 observations do not appear equivalent to high-volume hosts.",
        "minimumOccurrences": args.host_pattern_min_occurrences,
        "weights": weights_json(metadata, weights),
        "patterns": patterns,
        "hosts": hosts,
    })
}

#[derive(Clone)]
struct HeaderMode {
    id: &'static str,
    title: &'static str,
    base: usize,
    fragment: bool,
    cjk: bool,
}

#[derive(Clone, Debug)]
struct SplitPlan {
    tier1_entry_count: usize,
    tier1_lead_states: usize,
    tier2_lead_states: usize,
    tier3_lead_states: usize,
    unused_lead_states: usize,
    tier2_capacity: u64,
    tier3_capacity: u64,
    populated_tier1: usize,
    populated_tier2: usize,
    populated_tier3: usize,
    total_score: f64,
}

fn build_headers(
    candidates: &[HeaderCandidate],
    observed_candidates: usize,
    distinct_hosts: usize,
    distinct_suffixes: usize,
    metadata: &CubeMetadata,
    weights: &Weights,
    args: &ReportArgs,
) -> Result<Value, String> {
    let modes = [
        HeaderMode {
            id: "ascii",
            title: "ASCII extended",
            base: ASCII_BASE,
            fragment: false,
            cjk: false,
        },
        HeaderMode {
            id: "ascii-fragment",
            title: "ASCII extended + fragment",
            base: ASCII_FRAGMENT_BASE,
            fragment: true,
            cjk: false,
        },
        HeaderMode {
            id: "cjk",
            title: "CJK",
            base: CJK_BASE,
            fragment: false,
            cjk: true,
        },
        HeaderMode {
            id: "cjk-fragment",
            title: "CJK + fragment",
            base: CJK_FRAGMENT_BASE,
            fragment: true,
            cjk: true,
        },
    ];
    let mode_reports = modes
        .iter()
        .map(|mode| {
            optimize_header_mode(
                mode,
                candidates,
                observed_candidates,
                metadata,
                weights,
                args,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "generatedAt": generated_at(),
        "objective": "Estimated input characters removed after paying for a 1-, 2-, or 3-character header, multiplied by post-hoc dataset/context weights.",
        "caveat": "The allocation search is exact for the stated additive estimate. The held-out radix simulation remains the final validation because host and suffix symbols can overlap on the same URL.",
        "structuralStates": STRUCTURAL_STATES,
        "genericLeadStates": GENERIC_LEADS,
        "weights": weights_json(metadata, weights),
        "observed": {
            "distinctHosts": distinct_hosts,
            "distinctSuffixes": distinct_suffixes,
            "eligibleCandidates": observed_candidates,
            "evaluatedCandidates": candidates.len(),
            "candidatePoolTruncated": candidates.len() < observed_candidates,
        },
        "modes": mode_reports,
    }))
}

fn optimize_header_mode(
    mode: &HeaderMode,
    candidates: &[HeaderCandidate],
    observed_candidates: usize,
    metadata: &CubeMetadata,
    weights: &Weights,
    args: &ReportArgs,
) -> Result<Value, String> {
    let (fixed, remaining): (Vec<_>, Vec<_>) = candidates.iter().cloned().partition(|entry| {
        entry.kind == "suffix" && FIXED_ASCII_SUFFIXES.contains(&entry.aggregate.key.as_str())
    });
    let maximum_tier1_entries = FIXED_ASCII_SUFFIXES
        .len()
        .max((mode.base.saturating_sub(GENERIC_LEADS)) / STRUCTURAL_STATES - 1);
    let tier1_counts = if mode.cjk {
        (FIXED_ASCII_SUFFIXES.len()..=maximum_tier1_entries).collect::<Vec<_>>()
    } else {
        vec![FIXED_ASCII_SUFFIXES.len()]
    };
    let fixed_score = fixed.iter().map(|entry| entry.tier_scores[0]).sum::<f64>();
    let prefix = [0_usize, 1, 2].map(|tier| score_prefix(&remaining, tier));
    let mut best_two: Option<SplitPlan> = None;
    let mut best_three: Option<SplitPlan> = None;
    let mut curve = Vec::new();
    for tier1_entry_count in tier1_counts {
        let tier1_leads = STRUCTURAL_STATES * (tier1_entry_count + 1);
        let Some(extended_leads) = mode.base.checked_sub(GENERIC_LEADS + tier1_leads) else {
            continue;
        };
        let maximum_useful_tier2 =
            extended_leads.min((candidates.len() * STRUCTURAL_STATES).div_ceil(mode.base) + 1);
        let up_to_two = evaluate_plan(
            mode,
            fixed.len(),
            fixed_score,
            &prefix,
            remaining.len(),
            tier1_entry_count,
            tier1_leads,
            extended_leads,
            0,
        );
        replace_if_better(&mut best_two, up_to_two);
        let mut best_for_tier1 = None;
        for tier2_leads in 0..=maximum_useful_tier2 {
            let tier2_capacity = tier2_leads.saturating_mul(mode.base) / STRUCTURAL_STATES;
            let after_tier1 = remaining
                .len()
                .saturating_sub(tier1_entry_count.saturating_sub(fixed.len()));
            let needing_tier3 = after_tier1.saturating_sub(tier2_capacity);
            let tier3_leads = extended_leads
                .saturating_sub(tier2_leads)
                .min(div_ceil_u128(
                    needing_tier3 as u128 * STRUCTURAL_STATES as u128,
                    mode.base as u128 * mode.base as u128,
                ) as usize);
            let plan = evaluate_plan(
                mode,
                fixed.len(),
                fixed_score,
                &prefix,
                remaining.len(),
                tier1_entry_count,
                tier1_leads,
                tier2_leads,
                tier3_leads,
            );
            replace_if_better(&mut best_three, plan.clone());
            replace_if_better(&mut best_for_tier1, plan);
        }
        if let Some(plan) = best_for_tier1 {
            curve.push(plan);
        }
    }
    let best_two = best_two.ok_or_else(|| format!("no two-character split for {}", mode.id))?;
    let best_three =
        best_three.ok_or_else(|| format!("no three-character split for {}", mode.id))?;
    let one_count = if mode.cjk {
        maximum_tier1_entries
    } else {
        FIXED_ASCII_SUFFIXES.len()
    };
    let one_leads = STRUCTURAL_STATES * (one_count + 1);
    let one_only = evaluate_plan(
        mode,
        fixed.len(),
        fixed_score,
        &prefix,
        remaining.len(),
        one_count,
        one_leads,
        0,
        0,
    );
    let curve = sample_curve(curve, args.header_curve_rows)
        .iter()
        .map(split_summary_json)
        .collect::<Vec<_>>();
    let theoretical_two = FIXED_ASCII_SUFFIXES.len() as u128
        + ((mode.base - GENERIC_LEADS - STRUCTURAL_STATES * 4) as u128 * mode.base as u128)
            / STRUCTURAL_STATES as u128;
    let theoretical_three = FIXED_ASCII_SUFFIXES.len() as u128
        + ((mode.base - GENERIC_LEADS - STRUCTURAL_STATES * 4) as u128
            * mode.base as u128
            * mode.base as u128)
            / STRUCTURAL_STATES as u128;
    Ok(json!({
        "id": mode.id,
        "title": mode.title,
        "base": mode.base,
        "fragment": mode.fragment,
        "cjk": mode.cjk,
        "fragmentPrefixCharacters": if mode.fragment { 1 } else { 0 },
        "observedCandidateCount": observed_candidates,
        "evaluatedCandidateCount": candidates.len(),
        "candidatePoolTruncated": candidates.len() < observed_candidates,
        "variants": [
            {"maxHeaderCharacters": 1, "best": split_summary_json(&one_only)},
            {"maxHeaderCharacters": 2, "best": split_summary_json(&best_two)},
            {"maxHeaderCharacters": 3, "best": split_summary_json(&best_three)},
        ],
        "marginalSavings": {
            "allowingTwoCharacters": best_two.total_score - one_only.total_score,
            "allowingThreeCharacters": best_three.total_score - best_two.total_score,
        },
        "theoreticalMaximumCandidatesWithinTwoCharacters": theoretical_two,
        "theoreticalMaximumDedicatedOneCharacterEntries": maximum_tier1_entries,
        "theoreticalMaximumCandidatesWithinThreeCharacters": theoretical_three,
        "allObservedCandidatesFitWithinTwoCharacters": theoretical_two >= observed_candidates as u128,
        "allObservedCandidatesFitWithinThreeCharacters": theoretical_three >= observed_candidates as u128,
        "best": materialize_plan(&best_three, &fixed, &remaining, metadata, weights),
        "splitCurve": curve,
    }))
}

fn score_prefix(candidates: &[HeaderCandidate], tier: usize) -> Vec<f64> {
    let mut prefix = Vec::with_capacity(candidates.len() + 1);
    prefix.push(0.0);
    for candidate in candidates {
        prefix.push(prefix.last().copied().unwrap() + candidate.tier_scores[tier]);
    }
    prefix
}

#[allow(clippy::too_many_arguments)]
fn evaluate_plan(
    mode: &HeaderMode,
    fixed_count: usize,
    fixed_score: f64,
    prefix: &[Vec<f64>; 3],
    remaining_count: usize,
    tier1_entry_count: usize,
    tier1_lead_states: usize,
    tier2_lead_states: usize,
    tier3_lead_states: usize,
) -> SplitPlan {
    let extra_tier1 = tier1_entry_count
        .saturating_sub(fixed_count)
        .min(remaining_count);
    let tier2_capacity =
        (tier2_lead_states as u128 * mode.base as u128 / STRUCTURAL_STATES as u128) as u64;
    let tier3_capacity = (tier3_lead_states as u128 * mode.base as u128 * mode.base as u128
        / STRUCTURAL_STATES as u128) as u64;
    let tier2_end = remaining_count.min(extra_tier1.saturating_add(tier2_capacity as usize));
    let tier3_end = remaining_count
        .min(tier2_end.saturating_add(tier3_capacity.min(usize::MAX as u64) as usize));
    let total_score = fixed_score
        + prefix[0][extra_tier1]
        + (prefix[1][tier2_end] - prefix[1][extra_tier1])
        + (prefix[2][tier3_end] - prefix[2][tier2_end]);
    SplitPlan {
        tier1_entry_count: fixed_count + extra_tier1,
        tier1_lead_states,
        tier2_lead_states,
        tier3_lead_states,
        unused_lead_states: mode.base.saturating_sub(
            GENERIC_LEADS + tier1_lead_states + tier2_lead_states + tier3_lead_states,
        ),
        tier2_capacity,
        tier3_capacity,
        populated_tier1: fixed_count + extra_tier1,
        populated_tier2: tier2_end - extra_tier1,
        populated_tier3: tier3_end - tier2_end,
        total_score,
    }
}

fn replace_if_better(target: &mut Option<SplitPlan>, candidate: SplitPlan) {
    if target
        .as_ref()
        .is_none_or(|current| candidate.total_score > current.total_score)
    {
        *target = Some(candidate);
    }
}

fn split_summary_json(plan: &SplitPlan) -> Value {
    json!({
        "tier1EntryCount": plan.tier1_entry_count,
        "tier1LeadStates": plan.tier1_lead_states,
        "tier2LeadStates": plan.tier2_lead_states,
        "tier3LeadStates": plan.tier3_lead_states,
        "unusedLeadStates": plan.unused_lead_states,
        "tier2Capacity": plan.tier2_capacity,
        "tier3Capacity": plan.tier3_capacity,
        "totalScore": plan.total_score,
        "populatedTier1Entries": plan.populated_tier1,
        "populatedTier2Entries": plan.populated_tier2,
        "populatedTier3Entries": plan.populated_tier3,
        "populatedEntries": plan.populated_tier1 + plan.populated_tier2 + plan.populated_tier3,
    })
}

fn materialize_plan(
    plan: &SplitPlan,
    fixed: &[HeaderCandidate],
    remaining: &[HeaderCandidate],
    metadata: &CubeMetadata,
    weights: &Weights,
) -> Value {
    let extra_tier1 = plan.populated_tier1.saturating_sub(fixed.len());
    let tier2_end = extra_tier1 + plan.populated_tier2;
    let tier3_end = tier2_end + plan.populated_tier3;
    let mut tier1 = fixed
        .iter()
        .map(|entry| header_choice(entry, 0, metadata, weights))
        .collect::<Vec<_>>();
    tier1.extend(
        remaining[..extra_tier1]
            .iter()
            .map(|entry| header_choice(entry, 0, metadata, weights)),
    );
    let tier2 = remaining[extra_tier1..tier2_end]
        .iter()
        .map(|entry| header_choice(entry, 1, metadata, weights))
        .collect::<Vec<_>>();
    let tier3 = remaining[tier2_end..tier3_end]
        .iter()
        .map(|entry| header_choice(entry, 2, metadata, weights))
        .collect::<Vec<_>>();
    extend_object(
        split_summary_json(plan),
        [
            ("tier1", json!(tier1)),
            ("tier2", json!(tier2)),
            ("tier3", json!(tier3)),
        ],
    )
}

fn header_choice(
    entry: &HeaderCandidate,
    tier: usize,
    metadata: &CubeMetadata,
    weights: &Weights,
) -> Value {
    extend_object(
        aggregate_result(&entry.aggregate, metadata, weights),
        [
            ("kind", json!(entry.kind)),
            ("removedCharacters", json!(entry.removed_characters)),
            ("score", json!(entry.tier_scores[tier])),
        ],
    )
}

fn sample_curve(rows: Vec<SplitPlan>, maximum: usize) -> Vec<SplitPlan> {
    if rows.len() <= maximum {
        return rows;
    }
    if maximum <= 1 {
        return vec![rows[0].clone()];
    }
    let mut indexes = vec![0, rows.len() - 1];
    for index in 0..maximum {
        indexes.push(
            ((index as f64 * (rows.len() - 1) as f64) / (maximum - 1) as f64).round() as usize,
        );
    }
    indexes.sort_unstable();
    indexes.dedup();
    indexes
        .into_iter()
        .map(|index| rows[index].clone())
        .collect()
}

fn div_ceil_u128(numerator: u128, denominator: u128) -> u128 {
    if numerator == 0 {
        0
    } else {
        (numerator - 1) / denominator + 1
    }
}

fn aggregate_result(entry: &Aggregate, metadata: &CubeMetadata, weights: &Weights) -> Value {
    json!({
        "key": entry.key,
        "rawCount": entry.raw_count,
        "weightedCount": entry.weighted_count,
        "topDatasets": top_dataset_contributions(entry, metadata, weights, 5),
        "topContexts": top_context_contributions(entry, metadata, weights, 5),
    })
}

fn top_dataset_contributions(
    entry: &Aggregate,
    metadata: &CubeMetadata,
    weights: &Weights,
    limit: usize,
) -> Value {
    let mut rows = metadata
        .datasets
        .iter()
        .enumerate()
        .filter_map(|(dataset, name)| {
            let raw_count = entry.by_dataset[dataset];
            if raw_count == 0 { return None; }
            let score = entry
                .counts
                .iter()
                .filter(|(signal, _)| *signal as usize / metadata.contexts.len() == dataset)
                .map(|(signal, count)| {
                    *count as f64 * weights.datasets[dataset] * weights.contexts[*signal as usize % metadata.contexts.len()]
                })
                .sum::<f64>();
            Some(json!({"name": name, "rawCount": raw_count, "weight": weights.datasets[dataset], "score": score}))
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        compare_f64_desc(
            left["score"].as_f64().unwrap(),
            right["score"].as_f64().unwrap(),
        )
        .then_with(|| {
            right["rawCount"]
                .as_u64()
                .unwrap()
                .cmp(&left["rawCount"].as_u64().unwrap())
        })
    });
    rows.truncate(limit);
    json!(rows)
}

fn top_context_contributions(
    entry: &Aggregate,
    metadata: &CubeMetadata,
    weights: &Weights,
    limit: usize,
) -> Value {
    let mut rows = metadata
        .contexts
        .iter()
        .enumerate()
        .filter_map(|(context, name)| {
            let raw_count = entry.by_context[context];
            if raw_count == 0 { return None; }
            let score = entry
                .counts
                .iter()
                .filter(|(signal, _)| *signal as usize % metadata.contexts.len() == context)
                .map(|(signal, count)| {
                    let dataset = *signal as usize / metadata.contexts.len();
                    *count as f64 * weights.datasets[dataset] * weights.contexts[context]
                })
                .sum::<f64>();
            Some(json!({"name": name, "rawCount": raw_count, "weight": weights.contexts[context], "score": score}))
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        compare_f64_desc(
            left["score"].as_f64().unwrap(),
            right["score"].as_f64().unwrap(),
        )
        .then_with(|| {
            right["rawCount"]
                .as_u64()
                .unwrap()
                .cmp(&left["rawCount"].as_u64().unwrap())
        })
    });
    rows.truncate(limit);
    json!(rows)
}

fn weights_json(metadata: &CubeMetadata, weights: &Weights) -> Value {
    json!({
        "datasets": named_weights(&metadata.datasets, &weights.datasets),
        "contexts": named_weights(&metadata.contexts, &weights.contexts),
    })
}

fn named_weights(names: &[String], weights: &[f64]) -> Value {
    Value::Object(
        names
            .iter()
            .cloned()
            .zip(weights.iter().map(|weight| json!(weight)))
            .collect(),
    )
}

fn extend_object<const N: usize>(mut value: Value, fields: [(&str, Value); N]) -> Value {
    let object = value.as_object_mut().unwrap();
    for (key, field) in fields {
        object.insert(key.to_string(), field);
    }
    value
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let file = File::create(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, value).map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|error| format!("{}: {error}", path.display()))
}

fn render_header_markdown(report: &Value) -> String {
    let mut output = format!(
        "# Header shortlists by output mode\n\n{}\n\n{}\n\n",
        report["objective"].as_str().unwrap_or(""),
        report["caveat"].as_str().unwrap_or("")
    );
    for mode in report["modes"].as_array().unwrap() {
        let best = &mode["best"];
        output.push_str(&format!(
            "## {}\n\nBase: **{}**  \nFragment prefix: **{} character{}**  \nObserved candidates: **{}**; evaluated shortlist pool: **{}**{}  \nMaximum dedicated one-character entries: **{}**  \nTheoretical candidate capacity through two characters: **{}**  \nEvery observed candidate fits within two characters: **{}**  \nMarginal score from allowing a third character: **{}**\n\n",
            mode["title"].as_str().unwrap_or(""),
            format_value(&mode["base"]),
            mode["fragmentPrefixCharacters"].as_u64().unwrap_or(0),
            if mode["fragmentPrefixCharacters"].as_u64() == Some(1) { "" } else { "s" },
            format_value(&mode["observedCandidateCount"]),
            format_value(&mode["evaluatedCandidateCount"]),
            if mode["candidatePoolTruncated"].as_bool() == Some(true) { " (truncated; raw cube retains the rest)" } else { "" },
            format_value(&mode["theoreticalMaximumDedicatedOneCharacterEntries"]),
            format_value(&mode["theoreticalMaximumCandidatesWithinTwoCharacters"]),
            if mode["allObservedCandidatesFitWithinTwoCharacters"].as_bool() == Some(true) { "yes" } else { "no" },
            format_value(&mode["marginalSavings"]["allowingThreeCharacters"]),
        ));
        output.push_str("### Maximum header-length comparison\n\n| max header chars | selected 1-char entries | 2-char capacity | 3-char capacity | populated entries | estimated savings |\n| ---: | ---: | ---: | ---: | ---: | ---: |\n");
        for variant in mode["variants"].as_array().unwrap() {
            let plan = &variant["best"];
            output.push_str(&format!(
                "| {} | {} | {} | {} | {} | {} |\n",
                variant["maxHeaderCharacters"],
                format_value(&plan["populatedTier1Entries"]),
                format_value(&plan["tier2Capacity"]),
                format_value(&plan["tier3Capacity"]),
                format_value(&plan["populatedEntries"]),
                format_value(&plan["totalScore"]),
            ));
        }
        output.push_str(&format!(
            "\nWinning unrestricted split: **{} / {} / {}** lead states for 1/2/3-character headers, with **{}** reserved/unused  \nShortlist sizes: **{} / {} / {}**  \nEstimated savings score: **{}**\n\n",
            best["tier1LeadStates"], best["tier2LeadStates"], best["tier3LeadStates"], best["unusedLeadStates"],
            format_value(&json_array_len(&best["tier1"])),
            format_value(&json_array_len(&best["tier2"])),
            format_value(&json_array_len(&best["tier3"])),
            format_value(&best["totalScore"]),
        ));
        output.push_str("### Lead split curve\n\n| 1-char entries | 1-char leads | 2-char leads | 3-char leads | unused leads | 2-char capacity | 3-char capacity | estimated savings |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
        for row in mode["splitCurve"].as_array().unwrap() {
            output.push_str(&format!(
                "| {} | {} | {} | {} | {} | {} | {} | {} |\n",
                row["tier1EntryCount"],
                row["tier1LeadStates"],
                row["tier2LeadStates"],
                row["tier3LeadStates"],
                row["unusedLeadStates"],
                format_value(&row["tier2Capacity"]),
                format_value(&row["tier3Capacity"]),
                format_value(&row["totalScore"]),
            ));
        }
        output.push_str("\n### Proposed one-character entries\n\n");
        output.push_str(&render_choices(&best["tier1"], 100));
        output.push_str("\n\n### Proposed two-character entries\n\n");
        output.push_str(&render_choices(&best["tier2"], 200));
        output.push_str("\n\n### Proposed three-character entries\n\n");
        output.push_str(&render_choices(&best["tier3"], 200));
        output.push_str("\n\nThe JSON report contains each complete evaluated shortlist; Markdown is intentionally capped.\n\n");
    }
    output
}

fn render_choices(entries: &Value, limit: usize) -> String {
    let mut output = "| entry | kind | raw uses | weighted uses | estimated savings |\n| --- | --- | ---: | ---: | ---: |\n".to_string();
    let rows = entries.as_array().map(Vec::as_slice).unwrap_or(&[]);
    if rows.is_empty() {
        output.push_str("| — | — | 0 | 0 | 0 |");
        return output;
    }
    for entry in rows.iter().take(limit) {
        output.push_str(&format!(
            "| `{}` | {} | {} | {} | {} |\n",
            escape_md(entry["key"].as_str().unwrap_or("")),
            entry["kind"].as_str().unwrap_or(""),
            format_value(&entry["rawCount"]),
            format_value(&entry["weightedCount"]),
            format_value(&entry["score"]),
        ));
    }
    output.trim_end().to_string()
}

fn render_symbols_markdown(report: &Value) -> String {
    let mut characters = String::new();
    for entry in report["literalCharacters"]
        .as_array()
        .unwrap()
        .iter()
        .take(160)
    {
        let encoded = serde_json::to_string(entry["key"].as_str().unwrap_or("")).unwrap();
        characters.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            escape_md(encoded.trim_matches('"')),
            format_value(&entry["rawCount"]),
            format_value(&entry["weightedCount"]),
            format_value(&entry["estimatedBitsSaved"]),
        ));
    }
    let mut terms = String::new();
    for entry in report["dictionaryTerms"]
        .as_array()
        .unwrap()
        .iter()
        .take(500)
    {
        terms.push_str(&format!(
            "| `{}` | {} | {} | {} | {} |\n",
            escape_md(entry["key"].as_str().unwrap_or("")),
            format_value(&entry["rawCount"]),
            format_value(&entry["weightedCount"]),
            entry["bitsPerUse"],
            format_value(&entry["estimatedBitsSaved"]),
        ));
    }
    format!(
        "# Common symbol candidates\n\nObjective: {}\n\nHeader-resolved legacy terms excluded: **{}**\n\nCarrier/radix alphabets are fixed by codec mode and are not trained. The character table below is frequency evidence for assigning internal literal token codes only.\n\n## Literal character frequency\n\n| character | raw occurrences | weighted occurrences | estimated bits saved |\n| --- | ---: | ---: | ---: |\n{}\n## Dictionary terms\n\n| term | raw uses | weighted uses | bits saved/use | estimated bits saved |\n| --- | ---: | ---: | ---: | ---: |\n{}",
        report["objective"].as_str().unwrap_or(""),
        report["excludedHeaderResolvedTerms"].as_u64().unwrap_or(0),
        characters,
        terms,
    )
}

fn render_patterns_markdown(report: &Value) -> String {
    let mut rows = String::new();
    for entry in report["patterns"].as_array().unwrap().iter().take(500) {
        let combined = entry["combinedToken"]
            .as_str()
            .map(|value| format!("`{}`", escape_md(value)))
            .unwrap_or_else(|| "—".to_string());
        rows.push_str(&format!(
            "| `{}` | {} | `{}` | {} | {:.2}% | {:.2}% | {} | {} | {} | {} |\n",
            escape_md(entry["host"].as_str().unwrap_or("")),
            entry["patternKind"].as_str().unwrap_or(""),
            escape_md(entry["term"].as_str().unwrap_or("")),
            format_value(&entry["rawCount"]),
            entry["rawHostCoverage"].as_f64().unwrap_or(0.0) * 100.0,
            entry["rawHostCoverageLowerBound95"].as_f64().unwrap_or(0.0) * 100.0,
            format_value(&entry["weightedCount"]),
            entry["tailBitsPerUse"],
            format_value(&entry["estimatedTailBitsSaved"]),
            combined,
        ));
    }
    if rows.is_empty() {
        rows.push_str("| — | — | — | 0 | 0% | 0% | 0 | 0 | 0 | — |\n");
    }
    let mut hosts = String::new();
    for host in report["hosts"].as_array().unwrap().iter().take(100) {
        hosts.push_str(&format!(
            "## {}\n\nRetained URLs for host: **{}**\n\n| pattern position | path/query pattern | matching URLs | coverage | 95% lower bound | estimated tail savings |\n| --- | --- | ---: | ---: | ---: | ---: |\n",
            escape_md(host["host"].as_str().unwrap_or("")), format_value(&host["rawUrls"])
        ));
        for entry in host["topByCoverage"].as_array().unwrap() {
            hosts.push_str(&format!(
                "| {} | `{}` | {} | {:.2}% | {:.2}% | {} |\n",
                entry["patternKind"].as_str().unwrap_or(""),
                escape_md(entry["term"].as_str().unwrap_or("")),
                format_value(&entry["rawCount"]),
                entry["rawHostCoverage"].as_f64().unwrap_or(0.0) * 100.0,
                entry["rawHostCoverageLowerBound95"].as_f64().unwrap_or(0.0) * 100.0,
                format_value(&entry["estimatedTailBitsSaved"]),
            ));
        }
        hosts.push('\n');
    }
    format!(
        "# Host-conditioned URL patterns\n\n{}\n\n{}\n\nMinimum matching URLs included in this report: **{}**. The raw cube retains the lower-frequency tail.\n\n## Globally highest estimated savings\n\n| host | position | reusable tail | matching URLs | host coverage | 95% lower bound | weighted uses | tail bits saved/use | estimated tail savings | contiguous combined candidate |\n| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n{}\n# Patterns by host\n\n{}",
        report["objective"].as_str().unwrap_or(""),
        report["coverageNote"].as_str().unwrap_or(""),
        format_value(&report["minimumOccurrences"]),
        rows,
        hosts,
    )
}

fn render_comparison_markdown(report: &Value) -> String {
    let mut datasets = String::new();
    for entry in report["datasets"].as_array().unwrap() {
        datasets.push_str(&format!(
            "| `{}` | `{}` | {} | {} | {} |\n",
            escape_md(entry["name"].as_str().unwrap_or("")),
            escape_md(entry["family"].as_str().unwrap_or("")),
            format_value(&entry["rawUrls"]),
            entry["datasetWeight"],
            format_value(&entry["contextWeightedScore"]),
        ));
    }
    let mut families = String::new();
    let mut detail = String::new();
    for entry in report["families"].as_array().unwrap() {
        let dataset_names = entry["datasets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| format!("`{}`", escape_md(name.as_str().unwrap_or(""))))
            .collect::<Vec<_>>()
            .join(", ");
        families.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            escape_md(entry["name"].as_str().unwrap_or("")),
            dataset_names,
            format_value(&entry["rawUrls"]),
            format_value(&entry["weightedScore"]),
        ));
        detail.push_str(&format!(
            "## {}\n\n### Hosts\n\n{}\n\n### Suffixes\n\n{}\n\n### Terms\n\n{}\n\n### Links found on\n\n{}\n\n",
            escape_md(entry["name"].as_str().unwrap_or("")),
            render_comparison_rows(&entry["top"]["host"]),
            render_comparison_rows(&entry["top"]["suffix"]),
            render_comparison_rows(&entry["top"]["term"]),
            render_comparison_rows(&entry["top"]["source"]),
        ));
    }
    format!(
        "# Dataset and source-family comparison\n\n## Datasets\n\n| dataset | family | raw URLs | configured weight | context-weighted score |\n| --- | --- | ---: | ---: | ---: |\n{}\n## Families\n\n| family | datasets | raw URLs | weighted score |\n| --- | --- | ---: | ---: |\n{}\n{}",
        datasets, families, detail,
    )
}

fn render_comparison_rows(rows: &Value) -> String {
    let mut output = "| entry | raw uses | weighted score |\n| --- | ---: | ---: |\n".to_string();
    for row in rows.as_array().unwrap() {
        output.push_str(&format!(
            "| `{}` | {} | {} |\n",
            escape_md(row["key"].as_str().unwrap_or("")),
            format_value(&row["rawCount"]),
            format_value(&row["score"]),
        ));
    }
    output.trim_end().to_string()
}

fn json_array_len(value: &Value) -> Value {
    json!(value.as_array().map(Vec::len).unwrap_or(0))
}

fn format_value(value: &Value) -> String {
    if let Some(value) = value.as_u64() {
        return group_digits(value.to_string());
    }
    if let Some(value) = value.as_i64() {
        return group_digits(value.to_string());
    }
    if let Some(value) = value.as_f64() {
        return group_digits(format!("{:.0}", value));
    }
    value.to_string()
}

fn group_digits(value: String) -> String {
    let (sign, digits) = value
        .strip_prefix('-')
        .map(|digits| ("-", digits))
        .unwrap_or(("", value.as_str()));
    let mut output = String::with_capacity(value.len() + value.len() / 3);
    output.push_str(sign);
    for (index, character) in digits.chars().enumerate() {
        if index != 0 && (digits.len() - index).is_multiple_of(3) {
            output.push(',');
        }
        output.push(character);
    }
    output
}

fn escape_md(value: &str) -> String {
    value.replace('|', "\\|").replace('`', "\\`")
}

#[cfg(test)]
mod tests {
    use super::generate;
    use crate::args::ReportArgs;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use serde_json::{json, Value};
    use std::fs::File;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    #[test]
    fn streams_and_reweights_cubes_into_all_report_artifacts() {
        let root = tempfile::tempdir().unwrap();
        let cube = root.path().join("fixture.jsonl.gz");
        write_fixture(&cube);
        let default_out = root.path().join("default");
        let reweighted_out = root.path().join("reweighted");

        generate(options(cube.clone(), default_out.clone(), None)).unwrap();
        generate(options(cube, reweighted_out.clone(), Some("telegram=10"))).unwrap();

        let defaults = read_json(default_out.join("common-symbols.json"));
        let reweighted = read_json(reweighted_out.join("common-symbols.json"));
        assert_eq!(defaults["dictionaryTerms"][0]["key"], "/discord/");
        assert_eq!(reweighted["dictionaryTerms"][0]["key"], "/telegram/");
        assert!(defaults.get("proposedLiteralAlphabet").is_none());
        assert_eq!(
            defaults["literalCharacterRankingPurpose"],
            "Frequency evidence for internal token-code assignment only; carrier alphabets are fixed by codec mode."
        );
        assert_eq!(defaults["excludedHeaderResolvedTerms"], 3);
        assert!(defaults["dictionaryTerms"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| {
                entry["key"] != ".com" && entry["key"] != ".com/" && entry["key"] != "www."
            }));

        let headers = read_json(reweighted_out.join("header-shortlists.json"));
        assert_eq!(
            headers["modes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|mode| mode["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["ascii", "ascii-fragment", "cjk", "cjk-fragment"]
        );
        assert_eq!(
            headers["modes"][2]["base"].as_u64().unwrap() + 1,
            headers["modes"][3]["base"]
        );
        assert_eq!(
            headers["modes"][2]["allObservedCandidatesFitWithinTwoCharacters"],
            true
        );

        let default_patterns = read_json(default_out.join("host-patterns.json"));
        let reweighted_patterns = read_json(reweighted_out.join("host-patterns.json"));
        assert_eq!(
            default_patterns["patterns"][0]["combinedToken"],
            "discord.example/watch?v="
        );
        assert_eq!(reweighted_patterns["patterns"][0]["term"], "/status/");
        assert_eq!(
            default_patterns["hosts"][0]["topByCoverage"][0]["rawHostCoverage"],
            0.8
        );
        assert!(
            default_patterns["hosts"][0]["topByCoverage"][0]["rawHostCoverageLowerBound95"]
                .as_f64()
                .unwrap()
                < 0.8
        );

        let manifest = read_json(reweighted_out.join("report-manifest.json"));
        assert_eq!(manifest["weights"]["datasets"]["telegram"], 10.0);
        for name in [
            "header-shortlists.md",
            "common-symbols.md",
            "source-comparison.md",
            "host-patterns.md",
            "hosts.jsonl",
        ] {
            assert!(reweighted_out.join(name).is_file(), "missing {name}");
        }
        assert!(std::fs::read_dir(&reweighted_out)
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("host-totals")));
    }

    fn options(cube: PathBuf, out_dir: PathBuf, dataset_weights: Option<&str>) -> ReportArgs {
        ReportArgs {
            cubes: vec![cube],
            out_dir,
            dataset_weights: dataset_weights.map(str::to_string),
            family_weights: None,
            context_weights: None,
            token_cost_bits: 12,
            symbol_limit: 256,
            term_limit: 2_000,
            host_pattern_limit: 50_000,
            host_pattern_host_limit: 500,
            host_patterns_per_host: 20,
            host_pattern_min_occurrences: 5,
            comparison_limit: 100,
            header_candidate_limit: 50_000,
            header_curve_rows: 128,
        }
    }

    fn write_fixture(path: &Path) {
        let rows = [
            json!({
                "type": "metadata", "schemaVersion": 1, "collection": "fixture",
                "datasets": ["discord", "telegram"], "datasetFamilies": ["discord", "telegram"],
                "contexts": ["message/visible-url"], "defaultDatasetWeights": [1, 1],
                "defaultContextWeights": [1], "signalIndex": "datasetIndex * contexts.length + contextIndex"
            }),
            json!({"type": "totals", "counts": [[0, 100], [1, 20]]}),
            json!({"type": "suffix", "key": "com", "counts": [[0, 100], [1, 20]]}),
            json!({"type": "host", "key": "discord.example", "counts": [[0, 100]]}),
            json!({"type": "host", "key": "telegram.example", "counts": [[1, 20]]}),
            json!({"type": "source", "key": "chat.example", "counts": [[0, 100], [1, 20]]}),
            json!({"type": "term", "key": "/discord/", "counts": [[0, 100]]}),
            json!({"type": "term", "key": "/telegram/", "counts": [[1, 20]]}),
            json!({"type": "term", "key": ".com", "counts": [[0, 10_000]]}),
            json!({"type": "term", "key": ".com/", "counts": [[0, 10_000]]}),
            json!({"type": "term", "key": "www.", "counts": [[0, 10_000]]}),
            json!({"type": "host-pattern", "host": "discord.example", "patternKind": "prefix-query", "term": "/watch?v=", "counts": [[0, 80]]}),
            json!({"type": "host-pattern", "host": "telegram.example", "patternKind": "path-segment", "term": "/status/", "counts": [[1, 15]]}),
            json!({"type": "character", "key": "d", "counts": [[0, 100]]}),
            json!({"type": "character", "key": "t", "counts": [[1, 20]]}),
        ];
        let file = File::create(path).unwrap();
        let mut gzip = GzEncoder::new(file, Compression::fast());
        for row in rows {
            serde_json::to_writer(&mut gzip, &row).unwrap();
            gzip.write_all(b"\n").unwrap();
        }
        gzip.finish().unwrap();
    }

    fn read_json(path: PathBuf) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }
}
