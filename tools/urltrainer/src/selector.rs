use crate::args::Args;
use crate::stats::{literal_bits, scored_candidates};
use crate::url_parts::{compression_body, parse_url_parts};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

const SCORE_SCALE: f64 = 100.0;

#[derive(Clone, Debug)]
pub struct SelectedToken {
    pub candidate: String,
    pub training_count: u64,
    pub saved_bits_per_use: i64,
    pub heldout_gain_bits: f64,
    pub dictionary_cost_bits: i64,
    pub net_score: f64,
}

#[derive(Clone, Debug)]
pub struct ShadowedToken {
    pub candidate: String,
    pub training_count: u64,
    pub initial_net_score: f64,
    pub final_net_score: f64,
}

#[derive(Clone, Debug, Default)]
pub struct SelectionReport {
    pub selected: Vec<SelectedToken>,
    pub shadowed: Vec<ShadowedToken>,
    pub heldout_urls: usize,
    pub candidate_pool: usize,
}

#[derive(Clone)]
struct Body {
    text: String,
    weight: f64,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
struct HeapEntry {
    score: i64,
    index: usize,
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.score
            .cmp(&other.score)
            .then_with(|| other.index.cmp(&self.index))
    }
}

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn select_tokens(
    candidates: &HashMap<String, u64>,
    heldout_urls: &[String],
    args: &Args,
) -> SelectionReport {
    let pool = scored_candidates(candidates, args.candidate_pool, args.token_cost_bits);
    let bodies = heldout_urls
        .iter()
        .take(args.heldout_urls)
        .map(|url| Body {
            text: compression_body(url).to_string(),
            weight: url_weight(url, args),
        })
        .collect::<Vec<_>>();

    if pool.is_empty() || bodies.is_empty() || args.token_budget == 0 {
        return SelectionReport {
            heldout_urls: bodies.len(),
            candidate_pool: pool.len(),
            ..SelectionReport::default()
        };
    }

    let mut coverage = bodies
        .iter()
        .map(|body| vec![false; body.text.len()])
        .collect::<Vec<_>>();
    let mut selected_indexes = HashSet::new();
    let mut heap = BinaryHeap::new();
    let mut initial_scores = vec![0.0; pool.len()];

    for (index, (candidate, _, _, _)) in pool.iter().enumerate() {
        let net = net_score(candidate, &bodies, &coverage, args);
        initial_scores[index] = net;
        if net > 0.0 {
            heap.push(HeapEntry {
                score: scaled_score(net),
                index,
            });
        }
    }

    let mut selected = Vec::new();
    while selected.len() < args.token_budget {
        let Some(entry) = heap.pop() else {
            break;
        };
        if selected_indexes.contains(&entry.index) {
            continue;
        }

        let candidate = &pool[entry.index].0;
        let current_net = net_score(candidate, &bodies, &coverage, args);
        let next_best = heap.peek().map(|entry| entry.score).unwrap_or(i64::MIN);
        if scaled_score(current_net) < entry.score && scaled_score(current_net) < next_best {
            if current_net > 0.0 {
                heap.push(HeapEntry {
                    score: scaled_score(current_net),
                    index: entry.index,
                });
            }
            continue;
        }

        if current_net <= 0.0 {
            continue;
        }

        selected_indexes.insert(entry.index);
        mark_coverage(candidate, &bodies, &mut coverage);
        let training_count = pool[entry.index].1;
        let saved_bits_per_use = pool[entry.index].2;
        let dictionary_cost_bits = dictionary_cost_bits(candidate, args);
        selected.push(SelectedToken {
            candidate: candidate.clone(),
            training_count,
            saved_bits_per_use,
            heldout_gain_bits: current_net + dictionary_cost_bits as f64,
            dictionary_cost_bits,
            net_score: current_net,
        });
    }

    let mut shadowed = Vec::new();
    for (index, (candidate, count, _, _)) in pool.iter().enumerate() {
        if selected_indexes.contains(&index) || initial_scores[index] <= 0.0 {
            continue;
        }
        let final_score = net_score(candidate, &bodies, &coverage, args);
        if final_score <= initial_scores[index] * 0.25 {
            shadowed.push(ShadowedToken {
                candidate: candidate.clone(),
                training_count: *count,
                initial_net_score: initial_scores[index],
                final_net_score: final_score,
            });
        }
    }
    shadowed.sort_by(|a, b| {
        b.initial_net_score
            .partial_cmp(&a.initial_net_score)
            .unwrap_or(Ordering::Equal)
    });
    shadowed.truncate(args.top.min(50));

    SelectionReport {
        selected,
        shadowed,
        heldout_urls: bodies.len(),
        candidate_pool: pool.len(),
    }
}

fn net_score(candidate: &str, bodies: &[Body], coverage: &[Vec<bool>], args: &Args) -> f64 {
    marginal_gain_bits(candidate, bodies, coverage, args)
        - dictionary_cost_bits(candidate, args) as f64
}

fn marginal_gain_bits(
    candidate: &str,
    bodies: &[Body],
    coverage: &[Vec<bool>],
    args: &Args,
) -> f64 {
    let saved_each = literal_bits(candidate) as i64 - args.token_cost_bits as i64;
    if saved_each <= 0 {
        return 0.0;
    }

    bodies
        .iter()
        .zip(coverage)
        .map(|(body, coverage)| {
            non_overlapping_uncovered_occurrences(&body.text, candidate, coverage) as f64
                * saved_each as f64
                * body.weight
        })
        .sum()
}

fn mark_coverage(candidate: &str, bodies: &[Body], coverage: &mut [Vec<bool>]) {
    for (body, coverage) in bodies.iter().zip(coverage) {
        let mut start = 0;
        while let Some(relative) = body.text[start..].find(candidate) {
            let index = start + relative;
            let end = index + candidate.len();
            if coverage[index..end].iter().all(|covered| !covered) {
                coverage[index..end].fill(true);
                start = end;
            } else {
                start = index + 1;
            }
        }
    }
}

fn non_overlapping_uncovered_occurrences(text: &str, candidate: &str, coverage: &[bool]) -> usize {
    let mut count = 0;
    let mut start = 0;
    while let Some(relative) = text[start..].find(candidate) {
        let index = start + relative;
        let end = index + candidate.len();
        if end <= coverage.len() && coverage[index..end].iter().all(|covered| !covered) {
            count += 1;
            start = end;
        } else {
            start = index + 1;
        }
    }
    count
}

fn dictionary_cost_bits(candidate: &str, args: &Args) -> i64 {
    (candidate.len() * 8 + args.dictionary_entry_overhead_bits) as i64
}

fn scaled_score(score: f64) -> i64 {
    (score * SCORE_SCALE).round() as i64
}

fn url_weight(url: &str, args: &Args) -> f64 {
    let body = compression_body(url);
    let parts = parse_url_parts(url);
    let opportunity = body.len().saturating_sub(args.shortener_overhead_chars);
    let length_weight = (opportunity.min(args.length_weight_cap) as f64
        / args.length_weight_cap.max(1) as f64)
        .max(0.25);

    if parts.path.is_empty() && parts.query.is_empty() {
        length_weight * 0.25
    } else {
        length_weight
    }
}

#[cfg(test)]
mod tests {
    use super::select_tokens;
    use crate::args::Args;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn args() -> Args {
        Args {
            dump: PathBuf::from("dummy"),
            format: crate::args::CorpusFormat::Externallinks,
            out: PathBuf::from("dummy.md"),
            limit: 0,
            sample_every: 1,
            threads: 1,
            top: 10,
            token_budget: 2,
            token_cost_bits: 12,
            heldout_urls: 10,
            heldout_every: 2,
            candidate_pool: 10,
            dictionary_entry_overhead_bits: 0,
            shortener_overhead_chars: 0,
            length_weight_cap: 64,
            read_order: crate::args::ReadOrder::Sequential,
            chunk_mib: 64,
            checkpoint_rows: 100_000,
            report_every_secs: 30,
        }
    }

    #[test]
    fn prefers_longer_boundary_token_when_coverage_matches() {
        let mut candidates = HashMap::new();
        candidates.insert(".com".to_string(), 10);
        candidates.insert(".com/".to_string(), 10);
        let heldout = vec!["https://example.com/path".to_string(); 10];

        let report = select_tokens(&candidates, &heldout, &args());

        assert_eq!(report.selected[0].candidate, ".com/");
    }
}
