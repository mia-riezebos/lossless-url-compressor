use clap::{Parser, ValueEnum};
use std::path::PathBuf;

#[derive(Parser, Debug, Clone)]
pub struct ReportArgs {
    #[arg(long, value_delimiter = ',', required = true)]
    pub cubes: Vec<PathBuf>,

    #[arg(long, default_value = "data/training/reports")]
    pub out_dir: PathBuf,

    #[arg(long)]
    pub dataset_weights: Option<String>,

    #[arg(long)]
    pub family_weights: Option<String>,

    #[arg(long)]
    pub context_weights: Option<String>,

    #[arg(long, default_value_t = 12)]
    pub token_cost_bits: usize,

    #[arg(long, default_value_t = 256)]
    pub symbol_limit: usize,

    #[arg(long, default_value_t = 2_000)]
    pub term_limit: usize,

    #[arg(long, default_value_t = 50_000)]
    pub host_pattern_limit: usize,

    #[arg(long, default_value_t = 500)]
    pub host_pattern_host_limit: usize,

    #[arg(long, default_value_t = 20)]
    pub host_patterns_per_host: usize,

    #[arg(long, default_value_t = 5)]
    pub host_pattern_min_occurrences: u64,

    #[arg(long, default_value_t = 100)]
    pub comparison_limit: usize,

    #[arg(long, default_value_t = 50_000)]
    pub header_candidate_limit: usize,

    #[arg(long, default_value_t = 128)]
    pub header_curve_rows: usize,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum CorpusFormat {
    Externallinks,
    CommonCrawlCdxj,
    CommonCrawlWat,
    MessagingArchives,
    PlainUrls,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum MessagingMediaFilter {
    None,
    Gif,
    Expanded,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum ReadOrder {
    Sequential,
    Interleaved,
}

#[derive(Parser, Debug, Clone)]
pub struct Args {
    pub dump: PathBuf,

    #[arg(long, value_enum, default_value_t = CorpusFormat::Externallinks)]
    pub format: CorpusFormat,

    #[arg(long, default_value = "data/wiki/simplewiki-rust-analysis.md")]
    pub out: PathBuf,

    #[arg(long, default_value = "data/publicsuffix/public_suffix_list.dat")]
    pub public_suffix_list: PathBuf,

    #[arg(long)]
    pub header_stats: Option<PathBuf>,

    #[arg(long)]
    pub header_heldout: Option<PathBuf>,

    #[arg(long)]
    pub raw_stats: Option<PathBuf>,

    #[arg(long, default_value = "unknown")]
    pub collection: String,

    #[arg(long, default_value_t = 100_000)]
    pub header_top_hosts: usize,

    #[arg(long, default_value_t = 5_000)]
    pub header_top_suffixes: usize,

    #[arg(long, default_value_t = 100_000)]
    pub header_top_terms: usize,

    #[arg(long, default_value_t = false)]
    pub header_only: bool,

    #[arg(long, default_value_t = 0)]
    pub limit: u64,

    #[arg(long, default_value_t = 1)]
    pub sample_every: u64,

    #[arg(long, default_value_t = num_cpus::get())]
    pub threads: usize,

    #[arg(long, default_value_t = 160)]
    pub top: usize,

    #[arg(long, default_value_t = 128)]
    pub token_budget: usize,

    #[arg(long, default_value_t = 12)]
    pub token_cost_bits: usize,

    #[arg(long, default_value_t = 20_000)]
    pub heldout_urls: usize,

    #[arg(long, default_value_t = 10)]
    pub heldout_every: u64,

    #[arg(long, default_value_t = 512)]
    pub candidate_pool: usize,

    #[arg(long, default_value_t = 16)]
    pub dictionary_entry_overhead_bits: usize,

    #[arg(long, default_value_t = 24)]
    pub shortener_overhead_chars: usize,

    #[arg(long, default_value_t = 256)]
    pub length_weight_cap: usize,

    #[arg(long, value_enum, default_value_t = ReadOrder::Sequential)]
    pub read_order: ReadOrder,

    #[arg(long, default_value_t = 64)]
    pub chunk_mib: u64,

    #[arg(long, default_value_t = 100_000)]
    pub checkpoint_rows: u64,

    #[arg(long, default_value_t = 30)]
    pub report_every_secs: u64,

    #[arg(long, value_enum, default_value_t = MessagingMediaFilter::Expanded)]
    pub messaging_media_filter: MessagingMediaFilter,

    #[arg(long, value_delimiter = ',')]
    pub messaging_exclude_hosts: Vec<String>,

    #[arg(long, default_value_t = false)]
    pub messaging_include_bots: bool,

    #[arg(long, default_value_t = 0)]
    pub messaging_message_limit: u64,
}
