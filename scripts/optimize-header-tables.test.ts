import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "pisszip-header-weights-"));

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe("header weight tuning", () => {
  test("reweights class-stratified artifacts without rescanning WAT", () => {
    const socialHost = "extremelylongsocialhostname.com";
    const webHost = "extremelylonggenericwebsite.com";
    const statsPath = join(temporaryDirectory, "stats.json");
    const heldoutPath = join(temporaryDirectory, "heldout.jsonl.gz");
    writeFileSync(statsPath, JSON.stringify({
      collection: "fixture",
      rowsSampled: 200,
      supportedUrls: 3_600,
      classes: ["social-post", "web"],
      defaultWeights: [32, 4],
      classTotals: [100, 100],
      topSuffixes: [["com", 3_600]],
      topHosts: [[socialHost, 3_200], [webHost, 400]],
      suffixClassCounts: [["com", [100, 100]]],
      hostClassCounts: [[socialHost, [100, 0]], [webHost, [0, 100]]],
    }));

    const records = [
      ...Array.from({ length: 10 }, () => ({
        url: `https://${socialHost}/article`,
        hostname: socialHost,
        suffix: "com",
        registrableDomain: socialHost,
        hasWww: false,
        linkClass: "social-post",
      })),
      ...Array.from({ length: 10 }, () => ({
        url: `https://${webHost}/article`,
        hostname: webHost,
        suffix: "com",
        registrableDomain: webHost,
        hasWww: false,
        linkClass: "web",
      })),
    ];
    writeFileSync(heldoutPath, gzipSync(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`));

    const defaults = optimize(statsPath, heldoutPath, "default");
    const reweighted = optimize(statsPath, heldoutPath, "reweighted", "social-post=0,web=1");

    expect(selectedHosts(defaults)).toContain(socialHost);
    expect(selectedHosts(reweighted)).not.toContain(socialHost);
    expect(selectedHosts(reweighted)).toContain(webHost);
    expect(reweighted.weights).toEqual({ "social-post": 0, web: 1 });
  });

  test("reweights exact source sites from preserved held-out provenance", () => {
    const redditTarget = "equallylongredditdestination.com";
    const facebookTarget = "equallylongfacebookdestin.com";
    const statsPath = join(temporaryDirectory, "source-stats.json");
    const heldoutPath = join(temporaryDirectory, "source-heldout.jsonl.gz");
    writeFileSync(statsPath, JSON.stringify({
      collection: "fixture",
      rowsSampled: 200,
      supportedUrls: 200,
      classes: ["social-post/visible-url"],
      defaultWeights: [1],
      classTotals: [200],
      topSuffixes: [["com", 200]],
      topHosts: [[redditTarget, 100], [facebookTarget, 100]],
      suffixClassCounts: [["com", [200]]],
      hostClassCounts: [[redditTarget, [100]], [facebookTarget, [100]]],
    }));
    const records = [
      ...Array.from({ length: 10 }, () => ({
        url: `https://${redditTarget}/article`,
        hostname: redditTarget,
        suffix: "com",
        registrableDomain: redditTarget,
        hasWww: false,
        linkClass: "social-post",
        linkPresentation: "visible-url",
        sourceRegistrableDomain: "reddit.com",
      })),
      ...Array.from({ length: 10 }, () => ({
        url: `https://${facebookTarget}/article`,
        hostname: facebookTarget,
        suffix: "com",
        registrableDomain: facebookTarget,
        hasWww: false,
        linkClass: "social-post",
        linkPresentation: "visible-url",
        sourceRegistrableDomain: "facebook.com",
      })),
    ];
    writeFileSync(heldoutPath, gzipSync(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`));

    const result = optimize(
      statsPath,
      heldoutPath,
      "source-reweighted",
      undefined,
      "reddit.com=4,facebook.com=0.25",
    );

    expect(result.sourceWeights).toEqual({ "reddit.com": 4, "facebook.com": 0.25 });
    expect(hostGain(result, redditTarget)).toBeGreaterThan(hostGain(result, facebookTarget));
  });

  test("does not allocate host symbols to established URL shorteners", () => {
    const shortener = "bit.ly";
    const normalHost = "ordinary-but-useful-destination.example";
    const statsPath = join(temporaryDirectory, "shortener-stats.json");
    const heldoutPath = join(temporaryDirectory, "shortener-heldout.jsonl.gz");
    writeFileSync(statsPath, JSON.stringify({
      collection: "fixture",
      rowsSampled: 200,
      supportedUrls: 20_100,
      classes: ["web"],
      defaultWeights: [1],
      classTotals: [200],
      topSuffixes: [["ly", 20_000], ["example", 100]],
      topHosts: [[shortener, 20_000], [normalHost, 100]],
      suffixClassCounts: [["ly", [20_000]], ["example", [100]]],
      hostClassCounts: [[shortener, [20_000]], [normalHost, [100]]],
    }));
    const records = [
      ...Array.from({ length: 10 }, () => ({
        url: `https://${shortener}/abcdef`,
        hostname: shortener,
        suffix: "ly",
        registrableDomain: shortener,
        hasWww: false,
        linkClass: "web",
      })),
      ...Array.from({ length: 10 }, () => ({
        url: `https://${normalHost}/article`,
        hostname: normalHost,
        suffix: "example",
        registrableDomain: normalHost,
        hasWww: false,
        linkClass: "web",
      })),
    ];
    writeFileSync(heldoutPath, gzipSync(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`));

    const result = optimize(statsPath, heldoutPath, "shortener-filter");

    expect(result.excludedHosts).toContain(shortener);
    expect(selectedHosts(result)).not.toContain(shortener);
    expect(selectedHosts(result)).toContain(normalHost);
    expect(result.ccTldWeight).toBe(0.85);
    expect(result.best.suffixes.find((entry: any) => entry.key === "ly")?.ccTldMultiplier).toBe(0.85);
    const report = readFileSync(join(temporaryDirectory, "shortener-filter.md"), "utf8");
    expect(report).toContain("## Links found on");
    expect(report).toContain("## One-character shortlist");
    expect(report).toContain("## Two-character shortlist");
    expect(report).toContain("## Three-character shortlist");
  });
});

function optimize(
  stats: string,
  heldout: string,
  name: string,
  weights?: string,
  sourceWeights?: string,
) {
  const output = join(temporaryDirectory, `${name}.json`);
  const markdown = join(temporaryDirectory, `${name}.md`);
  const args = [
    resolve("node_modules/tsx/dist/cli.mjs"),
    resolve("scripts/optimize-header-tables.ts"),
    "--stats", stats,
    "--heldout", heldout,
    "--out-json", output,
    "--out-markdown", markdown,
    "--limit-urls", "0",
    "--host-candidates", "10",
    "--suffix-candidates", "10",
  ];
  if (weights) args.push("--weights", weights);
  if (sourceWeights) args.push("--source-weights", sourceWeights);
  execFileSync(process.execPath, args, { stdio: "pipe" });
  return JSON.parse(readFileSync(output, "utf8"));
}

function hostGain(result: any, host: string) {
  const entry = [...result.best.tier2Hosts, ...result.best.tier3Hosts]
    .find((candidate: any) => candidate.key === host);
  return entry?.score ?? 0;
}

function selectedHosts(result: any) {
  return [
    ...result.best.tier2Hosts.map((entry: any) => entry.key),
    ...result.best.tier3Hosts.map((entry: any) => entry.key),
  ];
}
