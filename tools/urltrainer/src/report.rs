use crate::args::Args;
use crate::counter::top_entries;
use crate::selector::{select_tokens, SelectionReport};
use crate::stats::{percentile, scored_candidates, Stats};
use std::fs::File;
use std::io::Write;

pub fn write_report(args: &Args, stats: &Stats, include_selection: bool) -> Result<(), String> {
    if let Some(parent) = args.out.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut file = File::create(&args.out).map_err(|err| err.to_string())?;

    writeln!(file, "# URL trainer analysis\n").map_err(|err| err.to_string())?;
    writeln!(file, "Rows seen: {}", stats.seen).map_err(|err| err.to_string())?;
    writeln!(file, "Rows sampled: {}", stats.sampled).map_err(|err| err.to_string())?;
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
        "Top path segments",
        &top_entries(&stats.path_segments, args.top),
    )?;
    write_table(
        &mut file,
        "Top query keys",
        &top_entries(&stats.query_keys, args.top),
    )?;

    if include_selection {
        let selection = select_tokens(&stats.candidates, &stats.heldout_urls, args);
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
