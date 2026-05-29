mod args;
mod candidates;
mod cdxj;
mod config;
mod counter;
mod report;
mod selector;
mod sql;
mod stats;
mod url_parts;

use args::{Args, CorpusFormat};
use clap::Parser;
use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender};
use stats::Stats;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};
use url_parts::domain_index_to_url;

fn main() -> Result<(), String> {
    let args = Args::parse();
    let (line_sender, line_receiver) = bounded::<String>(args.threads * 8);
    let (stats_sender, stats_receiver) = bounded::<Stats>(args.threads * 4);
    let processed = Arc::new(AtomicU64::new(0));
    let mut workers = Vec::new();

    for _ in 0..args.threads {
        let receiver = line_receiver.clone();
        let stats_sender = stats_sender.clone();
        let args = args.clone();
        let processed = Arc::clone(&processed);
        workers.push(thread::spawn(move || {
            worker(receiver, stats_sender, args, processed)
        }));
    }
    drop(stats_sender);

    let aggregator_args = args.clone();
    let aggregator = thread::spawn(move || aggregate(stats_receiver, aggregator_args));

    match args.format {
        CorpusFormat::Externallinks => {
            sql::read_insert_lines(&args.dump, args.read_order, args.chunk_mib, |line| {
                line_sender.send(line).map_err(|err| err.to_string())
            })?;
        }
        CorpusFormat::CommonCrawlCdxj => {
            cdxj::read_cdxj_lines(&args.dump, |line| {
                line_sender.send(line).map_err(|err| err.to_string())
            })?;
        }
    }
    drop(line_sender);

    for worker in workers {
        worker.join().map_err(|_| "worker panicked")??;
    }

    let total = aggregator.join().map_err(|_| "aggregator panicked")??;
    report::write_report(&args, &total, true)?;
    println!(
        "wrote {} (seen={}, sampled={})",
        args.out.display(),
        total.seen,
        total.sampled
    );
    Ok(())
}

fn worker(
    receiver: Receiver<String>,
    stats_sender: Sender<Stats>,
    args: Args,
    processed: Arc<AtomicU64>,
) -> Result<(), String> {
    let mut stats = Stats::new();
    let mut checkpoint_sampled = 0;

    for line in receiver {
        match args.format {
            CorpusFormat::Externallinks => {
                for (domain_index, path) in sql::parse_insert_line(&line) {
                    let row = processed.fetch_add(1, Ordering::Relaxed) + 1;
                    stats.seen += 1;
                    if !should_sample(row, &args) {
                        continue;
                    }

                    let Some(url) = domain_index_to_url(&domain_index, &path) else {
                        continue;
                    };
                    add_sampled_url(
                        &url,
                        row,
                        &mut stats,
                        &mut checkpoint_sampled,
                        &stats_sender,
                        &args,
                    )?;
                }
            }
            CorpusFormat::CommonCrawlCdxj => {
                let row = processed.fetch_add(1, Ordering::Relaxed) + 1;
                stats.seen += 1;
                if !should_sample(row, &args) {
                    continue;
                }

                if let Some(url) = cdxj::extract_url(&line) {
                    add_sampled_url(
                        &url,
                        row,
                        &mut stats,
                        &mut checkpoint_sampled,
                        &stats_sender,
                        &args,
                    )?;
                }
            }
        }
    }

    stats_sender.send(stats).map_err(|err| err.to_string())
}

fn should_sample(row: u64, args: &Args) -> bool {
    if args.sample_every != 0 && row % args.sample_every != 0 {
        return false;
    }
    if args.limit != 0 && row / args.sample_every.max(1) > args.limit {
        return false;
    }
    true
}

fn add_sampled_url(
    url: &str,
    row: u64,
    stats: &mut Stats,
    checkpoint_sampled: &mut u64,
    stats_sender: &Sender<Stats>,
    args: &Args,
) -> Result<(), String> {
    let sampled_ordinal = stats.sampled + 1;
    stats.sampled = sampled_ordinal;
    *checkpoint_sampled += 1;
    let is_heldout = args.heldout_every != 0 && sampled_ordinal % args.heldout_every == 0;
    if is_heldout {
        stats.add_heldout_url(url, heldout_key(row), args.heldout_urls);
    }
    stats.add_url(url, !is_heldout, args.token_cost_bits);

    if args.checkpoint_rows != 0 && *checkpoint_sampled >= args.checkpoint_rows {
        stats_sender
            .send(std::mem::replace(stats, Stats::new()))
            .map_err(|err| err.to_string())?;
        *checkpoint_sampled = 0;
    }

    Ok(())
}

fn heldout_key(row: u64) -> u64 {
    let mut value = row.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn aggregate(receiver: Receiver<Stats>, args: Args) -> Result<Stats, String> {
    let mut total = Stats::new();
    let mut last_report = Instant::now();
    let report_interval = Duration::from_secs(args.report_every_secs.max(1));
    let partial_path = partial_report_path(&args);

    loop {
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(stats) => {
                total.merge(stats);
                total.truncate_heldout_urls(args.heldout_urls);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if last_report.elapsed() >= report_interval && total.seen > 0 {
            let mut partial_args = args.clone();
            partial_args.out = partial_path.clone();
            report::write_report(&partial_args, &total, false)?;
            eprintln!(
                "partial {} (seen={}, sampled={})",
                partial_args.out.display(),
                total.seen,
                total.sampled
            );
            last_report = Instant::now();
        }
    }

    if total.seen > 0 {
        let mut partial_args = args.clone();
        partial_args.out = partial_path;
        report::write_report(&partial_args, &total, false)?;
    }

    Ok(total)
}

fn partial_report_path(args: &Args) -> std::path::PathBuf {
    let mut path = args.out.clone();
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("analysis");
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("md");
    path.set_file_name(format!("{stem}.partial.{extension}"));
    path
}
