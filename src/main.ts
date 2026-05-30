import { VERSION, decodeUrlPayload, encodeUrl, extractPayloadSurface } from "./codec";
import "./style.css";

const input = getElement<HTMLTextAreaElement>("input");
const output = getElement<HTMLTextAreaElement>("output");
const allowFragment = getElement<HTMLInputElement>("allow-fragment");
const useCjkPayload = getElement<HTMLInputElement>("use-cjk-payload");
const useDictionary = getElement<HTMLInputElement>("use-dictionary");
const useNumbers = getElement<HTMLInputElement>("use-numbers");
const useReferences = getElement<HTMLInputElement>("use-references");
const origin = getElement<HTMLInputElement>("origin");
const stats = getElement<HTMLParagraphElement>("stats");
const error = getElement<HTMLParagraphElement>("error");
const decodedSection = getElement<HTMLElement>("decoded-section");
const decoded = getElement<HTMLParagraphElement>("decoded");
const openDecoded = getElement<HTMLAnchorElement>("open-decoded");

let syncing = false;

input.value = "https://x.com/yanorei32/status/2059594850694283362";

renderCurrentUrlDecode();
renderEncode();

for (const element of [input, allowFragment, useCjkPayload, useDictionary, useNumbers, useReferences, origin]) {
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
      return;
    }

    const result = encodeUrl(input.value, {
      allowFragment: allowFragment.checked,
      origin: origin.value,
      useCjkPayload: useCjkPayload.checked,
      tokenizer: {
        useDictionary: useDictionary.checked,
        useNumbers: useNumbers.checked,
        useReferences: useReferences.checked,
      },
    });

    syncing = true;
    output.value = result.shortUrl;
    syncing = false;
    stats.textContent = formatEncodeStats(result);
  } catch (caught) {
    syncing = true;
    output.value = "";
    syncing = false;
    stats.textContent = "";
    error.textContent = caught instanceof Error ? caught.message : String(caught);
  }
}

function renderDecodeFromOutput(): void {
  if (syncing || !output.value.trim()) return;

  try {
    const url = decodeUrlPayload(extractPayloadSurface(output.value.trim()));

    syncing = true;
    input.value = url;
    syncing = false;
    error.textContent = "";
    stats.textContent = "decoded output into input";
  } catch (caught) {
    stats.textContent = "output is not a valid compressed URL/payload yet";
    error.textContent = caught instanceof Error ? caught.message : String(caught);
  }
}

function formatEncodeStats(result: ReturnType<typeof encodeUrl>): string {
  return [
    `normalized: ${result.normalizedUrl}`,
    `carrier: ${result.carrier}`,
    `payload family: ${result.payloadFamily}`,
    `tokenizer: ${formatTokenizerMode()}`,
    `payload chars: ${result.stats.payloadLength}`,
    `short URL chars: ${result.stats.shortUrlLength}`,
    `ratio vs normalized URL: ${(result.stats.shortUrlLength / result.stats.normalizedLength).toFixed(2)}x`,
  ].join(" | ");
}

function formatTokenizerMode(): string {
  const enabled = [
    useDictionary.checked ? "dict" : undefined,
    useNumbers.checked ? "num" : undefined,
    useReferences.checked ? "ref" : undefined,
  ].filter(Boolean);
  return enabled.length === 0 ? "literals only" : enabled.join("+");
}

function renderCurrentUrlDecode(): void {
  const href = window.location.href;
  const marker = `/${VERSION}/`;

  if (!href.includes(marker)) return;

  try {
    const payload = extractPayloadSurface(href);
    const url = decodeUrlPayload(payload);

    decoded.textContent = url;
    openDecoded.href = url;
    decodedSection.hidden = false;
  } catch (caught) {
    decoded.textContent = caught instanceof Error ? caught.message : String(caught);
    openDecoded.removeAttribute("href");
    decodedSection.hidden = false;
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
