export const ASCII_SERVER_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/?";

export const ASCII_CLIENT_ALPHABET = `${ASCII_SERVER_ALPHABET}#`;

const CJK_START = 0x4e00;
const CJK_END = 0x9fff;

export const CJK_ALPHABET = Array.from(
  { length: CJK_END - CJK_START + 1 },
  (_, index) => String.fromCharCode(CJK_START + index),
).join("");

export function isAsciiSafePayload(payload: string): boolean {
  for (const char of payload) {
    if (char === "%" || char.charCodeAt(0) > 0x7f) return false;
  }

  return true;
}

export function isCjkPayload(payload: string): boolean {
  const body = payload.startsWith("#") ? payload.slice(1) : payload;
  if (!body) return false;

  for (const char of body) {
    const code = char.charCodeAt(0);
    if (code < CJK_START || code > CJK_END) return false;
  }

  return true;
}

export function hasClientFragment(fullUrlOrPayload: string): boolean {
  return fullUrlOrPayload.includes("#");
}
