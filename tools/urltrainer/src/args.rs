use clap::{Parser, ValueEnum};
use std::path::PathBuf;

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum CorpusFormat {
    Externallinks,
    CommonCrawlCdxj,
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
}
