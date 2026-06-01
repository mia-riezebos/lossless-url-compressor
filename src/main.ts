import { type CodecVersion, decodeCanonicalShortUrl, decodeShortUrl, encodeUrl, extractPayloadSurface } from "./codec";
import "./style.css";

const input = getElement<HTMLTextAreaElement>("input");
const output = getElement<HTMLTextAreaElement>("output");
const inputVisit = getElement<HTMLAnchorElement>("input-visit");
const outputVisit = getElement<HTMLAnchorElement>("output-visit");
const codecVersion = getElement<HTMLInputElement>("codec-version");
const allowFragment = getElement<HTMLInputElement>("allow-fragment");
const useCjkPayload = getElement<HTMLInputElement>("use-cjk-payload");
const stats = getElement<HTMLParagraphElement>("stats");
const views = getElement<HTMLParagraphElement>("views");
const error = getElement<HTMLParagraphElement>("error");

let syncing = false;

input.value = initialInputValue();

registerServiceWorker();
renderViewCounter();
if (!decodeCurrentUrl()) renderEncode();

for (const element of [input, codecVersion, allowFragment, useCjkPayload]) {
  element.addEventListener("input", renderEncode);
  element.addEventListener("change", renderEncode);
}

output.addEventListener("input", renderDecodeFromOutput);
output.addEventListener("change", renderDecodeFromOutput);

function renderEncode(): void {
  if (syncing) return;

  try {
    error.textContent = "";

    if (!input.value) {
      syncing = true;
      output.value = "";
      syncing = false;
      stats.textContent = "";
      updateVisitLinks();
      return;
    }

    const result = encodeUrl(input.value, {
      allowFragment: allowFragment.checked,
      origin: window.location.origin,
      useCjkPayload: useCjkPayload.checked,
      version: codecVersion.value as CodecVersion,
    });

    syncing = true;
    output.value = result.shortUrl;
    syncing = false;
    stats.textContent = formatEncodeStats(result);
    updateVisitLinks();
  } catch (caught) {
    syncing = true;
    output.value = "";
    syncing = false;
    stats.textContent = "";
    updateVisitLinks();
    error.textContent = caught instanceof Error ? caught.message : String(caught);
  }
}

function renderDecodeFromOutput(): void {
  if (syncing || !output.value.trim()) return;

  try {
    const decoded = decodeForUi(output.value.trim());

    syncing = true;
    input.value = decoded.url;
    syncing = false;
    updateVisitLinks();
    error.textContent = "";
    stats.textContent = decoded.canonical ? "decoded output into input" : "non-canonical short URL decoded locally; redirects are disabled";
  } catch (caught) {
    stats.textContent = "output is not a valid compressed URL/payload yet";
    error.textContent = caught instanceof Error ? caught.message : String(caught);
  }
}

function initialInputValue(): string {
  return new URLSearchParams(window.location.search).get("url") ?? "https://youtube.com/watch?v=dQw4w9WgXcQ";
}

function formatEncodeStats(result: ReturnType<typeof encodeUrl>): string {
  const ratio = result.stats.shortUrlLength / result.stats.normalizedLength;
  return `visible length: ${result.stats.shortUrlLength}/${result.stats.normalizedLength} chars (${ratio.toFixed(2)}x)`;
}

function decodeForUi(value: string): { url: string; canonical: boolean } {
  try {
    return { url: decodeCanonicalShortUrl(value), canonical: true };
  } catch {
    return { url: decodeShortUrl(value), canonical: false };
  }
}

function updateVisitLinks(): void {
  setVisitLink(inputVisit, input.value.trim());
  setVisitLink(outputVisit, output.value.trim());
}

function setVisitLink(link: HTMLAnchorElement, value: string): void {
  if (!value) {
    link.removeAttribute("href");
    return;
  }

  link.href = value;
}

function renderViewCounter(): void {
  fetch("/api/views")
    .then((response) => response.ok ? response.json() as Promise<{ views: number | null }> : { views: null })
    .then((body) => {
      views.textContent = typeof body.views === "number"
        ? `visits, last 7 days: ${body.views.toLocaleString()}`
        : "visits: unavailable";
    })
    .catch(() => {
      views.textContent = "visits: unavailable";
    });
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Offline support is best-effort; encoding/decoding should not depend on SW registration.
  });
}

function decodeCurrentUrl(): boolean {
  if (extractPayloadSurface(window.location.href) === window.location.href) return false;

  const payload = extractPayloadSurface(window.location.href);
  if (!payload) return false;

  try {
    window.location.replace(decodeCanonicalShortUrl(window.location.href));
    return true;
  } catch {
    try {
      const url = decodeShortUrl(window.location.href);
      syncing = true;
      input.value = url;
      output.value = window.location.href;
      syncing = false;
      updateVisitLinks();
      stats.textContent = "non-canonical short URL decoded locally; redirects are disabled";
      error.textContent = "";
      return true;
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught);
      return true;
    }
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as unknown as T;
}
