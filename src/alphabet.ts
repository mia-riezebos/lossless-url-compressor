export const ASCII_SERVER_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/?";

export const ASCII_CLIENT_ALPHABET = `${ASCII_SERVER_ALPHABET}#`;

export function isAsciiSafePayload(payload: string): boolean {
  for (const char of payload) {
    if (char === "%" || char.charCodeAt(0) > 0x7f) return false;
  }

  return true;
}

export function hasClientFragment(fullUrlOrPayload: string): boolean {
  return fullUrlOrPayload.includes("#");
}
