import { type CodecVersion, decodeShortUrl, encodeUrl, extractPayloadSurface } from "./codec";
import "./style.css";

const input = getElement<HTMLTextAreaElement>("input");
const output = getElement<HTMLTextAreaElement>("output");
const codecVersion = getElement<HTMLInputElement>("codec-version");
const allowFragment = getElement<HTMLInputElement>("allow-fragment");
const useCjkPayload = getElement<HTMLInputElement>("use-cjk-payload");
const stats = getElement<HTMLParagraphElement>("stats");
const error = getElement<HTMLParagraphElement>("error");

let syncing = false;

input.value = "https://youtube.com/watch?v=dQw4w9WgXcQ";

registerServiceWorker();
redirectCurrentUrlDecode();
renderEncode();

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
    const url = decodeShortUrl(output.value.trim());

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
  return `compression ratio: ${(result.stats.shortUrlLength / result.stats.normalizedLength).toFixed(2)}x`;
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Offline support is best-effort; encoding/decoding should not depend on SW registration.
  });
}

function redirectCurrentUrlDecode(): void {
  if (extractPayloadSurface(window.location.href) === window.location.href) return;

  try {
    const payload = extractPayloadSurface(window.location.href);
    if (!payload) return;
    window.location.replace(decodeShortUrl(window.location.href));
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : String(caught);
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as unknown as T;
}
