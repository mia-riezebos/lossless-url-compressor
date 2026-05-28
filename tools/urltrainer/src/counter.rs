use crate::config::MAX_COUNTER_KEYS;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

const PRUNE_FACTOR: usize = 2;

pub fn bump(counter: &mut HashMap<String, u64>, key: &str, max_key_len: usize) {
    if !key.is_empty() && key.len() <= max_key_len {
        *counter.entry(key.to_string()).or_default() += 1;
        prune_if_needed(counter);
    }
}

pub fn merge_counter(target: &mut HashMap<String, u64>, source: HashMap<String, u64>) {
    for (key, count) in source {
        *target.entry(key).or_default() += count;
    }
    prune(target);
}

pub fn prune_if_needed(counter: &mut HashMap<String, u64>) {
    if counter.len() > MAX_COUNTER_KEYS * PRUNE_FACTOR {
        prune(counter);
    }
}

pub fn prune(counter: &mut HashMap<String, u64>) {
    if counter.len() <= MAX_COUNTER_KEYS {
        return;
    }

    for threshold in [1, 2, 3, 5, 10] {
        counter.retain(|_, count| *count > threshold);
        if counter.len() <= MAX_COUNTER_KEYS {
            return;
        }
    }

    let keep: HashSet<String> = top_entries(counter, MAX_COUNTER_KEYS)
        .into_iter()
        .map(|(key, _)| key)
        .collect();
    counter.retain(|key, _| keep.contains(key));
}

pub fn top_entries(counter: &HashMap<String, u64>, limit: usize) -> Vec<(String, u64)> {
    let mut heap: BinaryHeap<Reverse<(u64, String)>> = BinaryHeap::new();

    for (key, count) in counter {
        heap.push(Reverse((*count, key.clone())));
        if heap.len() > limit {
            heap.pop();
        }
    }

    let mut out: Vec<_> = heap
        .into_iter()
        .map(|Reverse((count, key))| (key, count))
        .collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}
