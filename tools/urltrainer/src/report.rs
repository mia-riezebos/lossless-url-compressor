use crate::args::Args;
use crate::counter::top_entries;
use crate::stats::{percentile, scored_candidates, Stats};
use std::fs::File;
use std::io::Write;

pub fn write_report(args: &Args, stats: &Stats) -> Result<(), String> {
    if let Some(parent) = args.out.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut file = File::create(&args.out).map_err(|err| err.to_string())?;

    writeln!(file, "# URL trainer analysis\n").map_err(|err| err.to_string())?;
    writeln!(file, "Rows seen: {}", stats.seen).map_err(|err| err.to_string())?;
    writeln!(file, "Rows sampled: {}", stats.sampled).map_err(|err| err.to_string())?;
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

    writeln!(file, "## Top candidate dictionary entries\n| candidate | count | saved bits/use | total score |\n| --- | ---: | ---: | ---: |")
        .map_err(|err| err.to_string())?;
    for (candidate, count, saved_each, score) in scored_candidates(&stats.candidates, args.top) {
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
