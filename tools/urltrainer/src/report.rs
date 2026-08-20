use crate::args::{Args, CorpusFormat};
use crate::config::{MAX_COUNTER_KEYS, MAX_KEY_LEN};
use crate::corpus::{
    dataset_families, dataset_names, training_class_default_weights, training_class_names,
    ClassCounts, TRAINING_CLASS_COUNT,
};
use crate::counter::top_entries;
use crate::selector::{select_tokens, SelectionReport};
use crate::stats::{percentile, scored_candidates, SignalCounts, Stats};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap, HashSet},
    path::Path,
};

pub fn write_report(args: &Args, stats: &Stats, include_selection: bool) -> Result<(), String> {
    if let Some(parent) = args.out.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut file = File::create(&args.out).map_err(|err| err.to_string())?;

    writeln!(file, "# URL trainer analysis\n").map_err(|err| err.to_string())?;
    writeln!(file, "Rows seen: {}", stats.seen).map_err(|err| err.to_string())?;
    writeln!(file, "Rows sampled: {}", stats.sampled).map_err(|err| err.to_string())?;
    writeln!(file, "Weighted URL units: {}", stats.weighted).map_err(|err| err.to_string())?;
    writeln!(file, "Training held-out URLs: {}", stats.heldout_urls.len())
        .map_err(|err| err.to_string())?;
    writeln!(file, "Threads: {}", args.threads).map_err(|err| err.to_string())?;
    writeln!(
        file,
        "Body length p50/p90/p99: {} / {} / {}\n",
        percentile(&stats.lengths, 0.50),
        percentile(&stats.lengths, 0.90),
        percentile(&stats.lengths, 0.99)
    )
    .map_err(|err| err.to_string())?;

    write_table(&mut file, "Schemes", &top_entries(&stats.schemes, 20))?;
    write_table(&mut file, "Top TLDs", &top_entries(&stats.tlds, 50))?;
    write_table(
        &mut file,
        "Top public suffixes",
        &top_entries(&stats.suffixes, 100),
    )?;
    write_table(
        &mut file,
        "Top registrable hosts",
        &top_entries(&stats.hosts, args.top),
    )?;
    write_table(
        &mut file,
        "Top path segments",
        &top_entries(&stats.path_segments, args.top),
    )?;
    write_table(
        &mut file,
        "Top query keys",
        &top_entries(&stats.query_keys, args.top),
    )?;

    if include_selection {
        let heldout_urls = stats
            .heldout_urls
            .iter()
            .map(|(_, record)| record.clone())
            .collect::<Vec<_>>();
        let selection = select_tokens(&stats.candidates, &heldout_urls, args);
        write_selection(&mut file, &selection)?;
    } else {
        writeln!(
            file,
            "## Selected dictionary entries\n\nSkipped for partial report; final report runs held-out marginal selection.\n"
        )
        .map_err(|err| err.to_string())?;
    }

    writeln!(file, "## Top candidate dictionary entries\n| candidate | count | saved bits/use | total score |\n| --- | ---: | ---: | ---: |")
        .map_err(|err| err.to_string())?;
    for (candidate, count, saved_each, score) in
        scored_candidates(&stats.candidates, args.top, args.token_cost_bits)
    {
        writeln!(
            file,
            "| `{}` | {} | {} | {} |",
            escape_md(&candidate),
            count,
            saved_each,
            score
        )
        .map_err(|err| err.to_string())?;
    }

    writeln!(
        file,
        "\n## Rejected overfit candidates\n| candidate | count | reason |\n| --- | ---: | --- |"
    )
    .map_err(|err| err.to_string())?;
    for (candidate, count) in top_entries(&stats.rejected_candidates.counts, args.top) {
        let reason = stats
            .rejected_candidates
            .reasons
            .get(&candidate)
            .map(|reason| reason.as_str())
            .unwrap_or("unknown");
        writeln!(
            file,
            "| `{}` | {} | {} |",
            escape_md(&candidate),
            count,
            reason
        )
        .map_err(|err| err.to_string())?;
    }

    writeln!(
        file,
        "\n## Top body characters\n| char | count |\n| --- | ---: |"
    )
    .map_err(|err| err.to_string())?;
    let mut chars: Vec<_> = stats.chars.iter().collect();
    chars.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    for (char, count) in chars
        .into_iter()
        .filter(|(char, _)| char.is_ascii() && **char != '`')
        .take(args.top)
    {
        writeln!(
            file,
            "| `{}` | {} |",
            escape_md(&char.escape_default().to_string()),
            count
        )
        .map_err(|err| err.to_string())?;
    }

    Ok(())
}

pub fn write_header_artifacts(args: &Args, stats: &Stats) -> Result<(), String> {
    if let Some(path) = &args.header_stats {
        ensure_parent(path)?;
        let classes = training_class_names();
        let default_weights = training_class_default_weights();
        let output = serde_json::json!({
            "collection": args.collection,
            "source": corpus_description(args.format),
            "rowsSampled": stats.sampled,
            "supportedUrls": stats.weighted,
            "classes": classes,
            "defaultWeights": default_weights,
            "classTotals": stats.class_totals,
            "topSuffixes": top_entries(&stats.suffixes, args.header_top_suffixes),
            "topHosts": top_entries(&stats.hosts, args.header_top_hosts),
            "topSources": top_entries(&stats.source_sites, args.header_top_hosts),
            "suffixClassCounts": top_class_entries(
                &stats.suffix_class_counts,
                args.header_top_suffixes,
            ),
            "hostClassCounts": top_class_entries(
                &stats.host_class_counts,
                args.header_top_hosts,
            ),
            "sourceClassCounts": top_class_entries(
                &stats.source_class_counts,
                args.header_top_hosts,
            ),
            "termClassCounts": top_class_entries(
                &stats.candidate_class_counts,
                args.header_top_terms,
            ),
        });
        let file = File::create(path).map_err(|err| err.to_string())?;
        let mut file = BufWriter::new(file);
        serde_json::to_writer(&mut file, &output).map_err(|err| err.to_string())?;
        writeln!(file).map_err(|err| err.to_string())?;
        file.flush().map_err(|err| err.to_string())?;
        eprintln!("wrote {}", path.display());
    }

    if let Some(path) = &args.header_heldout {
        ensure_parent(path)?;
        let file = File::create(path).map_err(|err| err.to_string())?;
        let file = BufWriter::new(file);
        let gzip = path.extension().is_some_and(|extension| extension == "gz");
        let mut writer: Box<dyn Write> = if gzip {
            Box::new(flate2::write::GzEncoder::new(
                file,
                flate2::Compression::best(),
            ))
        } else {
            Box::new(file)
        };
        for (_, record) in &stats.heldout_urls {
            serde_json::to_writer(&mut writer, record).map_err(|err| err.to_string())?;
            writer.write_all(b"\n").map_err(|err| err.to_string())?;
        }
        writer.flush().map_err(|err| err.to_string())?;
        eprintln!("wrote {}", path.display());
    }
    Ok(())
}

pub fn write_raw_stats(args: &Args, stats: &Stats) -> Result<(), String> {
    let Some(path) = &args.raw_stats else {
        return Ok(());
    };
    ensure_parent(path)?;
    let file = File::create(path).map_err(|err| err.to_string())?;
    let file = BufWriter::new(file);
    let gzip = path.extension().is_some_and(|extension| extension == "gz");
    let mut writer: Box<dyn Write> = if gzip {
        Box::new(flate2::write::GzEncoder::new(
            file,
            flate2::Compression::fast(),
        ))
    } else {
        Box::new(file)
    };

    let metadata = serde_json::json!({
        "type": "metadata",
        "schemaVersion": 1,
        "collection": args.collection,
        "source": corpus_description(args.format),
        "rowsSeen": stats.seen,
        "rowsSampled": stats.sampled,
        "datasets": dataset_names(),
        "datasetFamilies": dataset_families(),
        "contexts": training_class_names(),
        "defaultDatasetWeights": vec![1_u64; dataset_names().len()],
        "defaultContextWeights": training_class_default_weights(),
        "signalIndex": "datasetIndex * contexts.length + contextIndex",
        "counterKeyLimit": MAX_COUNTER_KEYS,
        "maximumKeyBytes": MAX_KEY_LEN,
        "aggregateOnly": true,
    });
    write_json_line(&mut writer, &metadata)?;
    write_signal_row(
        &mut writer,
        "totals",
        None,
        &dense_to_sparse(&stats.signal_totals),
    )?;
    write_signal_counter(&mut writer, "scheme", &stats.scheme_signal_counts)?;
    write_signal_counter(&mut writer, "tld", &stats.tld_signal_counts)?;
    write_signal_counter(&mut writer, "suffix", &stats.suffix_signal_counts)?;
    write_signal_counter(&mut writer, "host", &stats.host_signal_counts)?;
    write_signal_counter(&mut writer, "source", &stats.source_signal_counts)?;
    write_signal_counter(&mut writer, "path-segment", &stats.path_signal_counts)?;
    write_signal_counter(&mut writer, "query-key", &stats.query_signal_counts)?;
    write_signal_counter(&mut writer, "term", &stats.candidate_signal_counts)?;
    write_host_pattern_counter(&mut writer, &stats.host_pattern_signal_counts)?;

    let mut chars = stats.char_signal_counts.iter().collect::<Vec<_>>();
    chars.sort_unstable_by_key(|(key, _)| **key);
    for (key, counts) in chars {
        write_signal_row(&mut writer, "character", Some(&key.to_string()), counts)?;
    }
    for (length, counts) in stats.length_signal_counts.iter().enumerate() {
        if !counts.is_empty() {
            write_signal_row(&mut writer, "length", Some(&length.to_string()), counts)?;
        }
    }
    writer.flush().map_err(|err| err.to_string())?;
    eprintln!("wrote {}", path.display());
    Ok(())
}

fn write_signal_counter(
    writer: &mut dyn Write,
    kind: &str,
    counter: &HashMap<String, SignalCounts>,
) -> Result<(), String> {
    let mut entries = counter.iter().collect::<Vec<_>>();
    entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
    for (key, counts) in entries {
        write_signal_row(writer, kind, Some(key), counts)?;
    }
    Ok(())
}

fn write_host_pattern_counter(
    writer: &mut dyn Write,
    counter: &HashMap<String, SignalCounts>,
) -> Result<(), String> {
    let mut entries = counter.iter().collect::<Vec<_>>();
    entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
    for (key, counts) in entries {
        let mut fields = key.splitn(3, '\t');
        let Some(host) = fields.next() else { continue };
        let Some(pattern_kind) = fields.next() else {
            continue;
        };
        let Some(term) = fields.next() else { continue };
        let row = serde_json::json!({
            "type": "host-pattern",
            "host": host,
            "patternKind": pattern_kind,
            "term": term,
            "counts": counts,
        });
        write_json_line(writer, &row)?;
    }
    Ok(())
}

fn write_signal_row(
    writer: &mut dyn Write,
    kind: &str,
    key: Option<&str>,
    counts: &SignalCounts,
) -> Result<(), String> {
    let row = match key {
        Some(key) => serde_json::json!({ "type": kind, "key": key, "counts": counts }),
        None => serde_json::json!({ "type": kind, "counts": counts }),
    };
    write_json_line(writer, &row)
}

fn write_json_line(writer: &mut dyn Write, value: &serde_json::Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value).map_err(|err| err.to_string())?;
    writer.write_all(b"\n").map_err(|err| err.to_string())
}

fn dense_to_sparse(counts: &[u64]) -> SignalCounts {
    counts
        .iter()
        .enumerate()
        .filter_map(|(index, count)| (*count != 0).then_some((index as u16, *count)))
        .collect()
}

fn corpus_description(format: CorpusFormat) -> &'static str {
    match format {
        CorpusFormat::CommonCrawlWat => {
            "Common Crawl WAT anchor targets, stratified by source context and link presentation"
        }
        CorpusFormat::MessagingArchives => {
            "URLs streamed from public messaging archives, classified by platform and forwarding context"
        }
        CorpusFormat::CommonCrawlCdxj => "Common Crawl CDX index URLs",
        CorpusFormat::Externallinks => "Wikimedia externallinks SQL dump URLs",
        CorpusFormat::PlainUrls => "Plain URL corpus",
    }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn top_class_entries(
    counter: &HashMap<String, ClassCounts>,
    per_class_limit: usize,
) -> Vec<(String, ClassCounts)> {
    let mut keep = HashSet::new();
    let mut heaps = (0..TRAINING_CLASS_COUNT)
        .map(|_| BinaryHeap::<Reverse<(u64, &String)>>::new())
        .collect::<Vec<_>>();
    for (key, counts) in counter {
        for (class_index, count) in counts.iter().copied().enumerate() {
            if count == 0 {
                continue;
            }
            let heap = &mut heaps[class_index];
            heap.push(Reverse((count, key)));
            if heap.len() > per_class_limit {
                heap.pop();
            }
        }
    }
    for heap in heaps {
        keep.extend(heap.into_iter().map(|Reverse((_, key))| key.clone()));
    }

    let default_weights = training_class_default_weights();
    let mut entries = counter
        .iter()
        .filter(|(key, _)| keep.contains(*key))
        .map(|(key, counts)| {
            let default_score = (0..TRAINING_CLASS_COUNT)
                .map(|index| counts[index] * default_weights[index].max(1))
                .sum::<u64>();
            (key, counts, default_score)
        })
        .collect::<Vec<_>>();
    entries.sort_unstable_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(b.0)));
    entries
        .into_iter()
        .map(|(key, counts, _)| (key.clone(), counts.clone()))
        .collect()
}

fn write_selection(file: &mut File, selection: &SelectionReport) -> Result<(), String> {
    writeln!(
        file,
        "## Selected dictionary entries\n\nHeld-out URLs scored: {}  \nCandidate pool: {}\n\n| candidate | train count | saved bits/use | held-out gain bits | dictionary cost bits | net score |\n| --- | ---: | ---: | ---: | ---: | ---: |",
        selection.heldout_urls, selection.candidate_pool
    )
    .map_err(|err| err.to_string())?;
    for token in &selection.selected {
        writeln!(
            file,
            "| `{}` | {} | {} | {:.1} | {} | {:.1} |",
            escape_md(&token.candidate),
            token.training_count,
            token.saved_bits_per_use,
            token.heldout_gain_bits,
            token.dictionary_cost_bits,
            token.net_score
        )
        .map_err(|err| err.to_string())?;
    }

    writeln!(
        file,
        "\n## Rejected by overlap shadowing\n| candidate | train count | initial net score | final net score |\n| --- | ---: | ---: | ---: |"
    )
    .map_err(|err| err.to_string())?;
    for token in &selection.shadowed {
        writeln!(
            file,
            "| `{}` | {} | {:.1} | {:.1} |",
            escape_md(&token.candidate),
            token.training_count,
            token.initial_net_score,
            token.final_net_score
        )
        .map_err(|err| err.to_string())?;
    }
    writeln!(file).map_err(|err| err.to_string())?;
    Ok(())
}

fn write_table(file: &mut File, heading: &str, rows: &[(String, u64)]) -> Result<(), String> {
    writeln!(file, "## {heading}\n| value | count |\n| --- | ---: |")
        .map_err(|err| err.to_string())?;
    for (value, count) in rows {
        writeln!(file, "| `{}` | {} |", escape_md(value), count).map_err(|err| err.to_string())?;
    }
    writeln!(file).map_err(|err| err.to_string())?;
    Ok(())
}

fn escape_md(value: &str) -> String {
    value.replace('`', "\\`")
}
