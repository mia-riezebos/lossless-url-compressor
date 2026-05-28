use clap::{Parser, ValueEnum};
use std::path::PathBuf;

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum ReadOrder {
    Sequential,
    Interleaved,
}

#[derive(Parser, Debug, Clone)]
pub struct Args {
    pub dump: PathBuf,

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

    #[arg(long, value_enum, default_value_t = ReadOrder::Sequential)]
    pub read_order: ReadOrder,

    #[arg(long, default_value_t = 64)]
    pub chunk_mib: u64,

    #[arg(long, default_value_t = 100_000)]
    pub checkpoint_rows: u64,

    #[arg(long, default_value_t = 30)]
    pub report_every_secs: u64,
}
