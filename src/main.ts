import { VERSION, decodeUrlPayload, encodeUrl, extractPayloadSurface } from "./codec";
import "./style.css";

const input = getElement<HTMLTextAreaElement>("input");
const output = getElement<HTMLTextAreaElement>("output");
const allowFragment = getElement<HTMLInputElement>("allow-fragment");
const useCjkPayload = getElement<HTMLInputElement>("use-cjk-payload");
const stats = getElement<HTMLParagraphElement>("stats");
const error = getElement<HTMLParagraphElement>("error");

let syncing = false;

input.value = "https://x.com/yanorei32/status/2059594850694283362";

redirectCurrentUrlDecode();
renderEncode();

for (const element of [input, allowFragment, useCjkPayload]) {
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
      origin: window.location.origin,
      useCjkPayload: useCjkPayload.checked,
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
    `payload: ${result.stats.payloadLength}`,
    `short URL: ${result.stats.shortUrlLength}`,
    `ratio: ${(result.stats.shortUrlLength / result.stats.normalizedLength).toFixed(2)}x`,
    `family: ${result.payloadFamily}`,
  ].join(" | ");
}

function redirectCurrentUrlDecode(): void {
  if (!window.location.href.includes(`/${VERSION}/`)) return;

  try {
    const payload = extractPayloadSurface(window.location.href);
    if (!payload) return;
    window.location.replace(decodeUrlPayload(payload));
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : String(caught);
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
