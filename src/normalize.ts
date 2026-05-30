const SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const AUTHORITY_END_PATTERN = /[/?#]/;

export type NormalizedUrl = {
  normalizedUrl: string;
  body: string;
  scheme: string;
  httpsOmitted: boolean;
};

export function normalizeForCompression(input: string): NormalizedUrl {
  const schemeMatch = SCHEME_PATTERN.exec(input);
  if (!schemeMatch) {
    throw new Error("Input must be an absolute URL with a scheme followed by //");
  }

  const scheme = schemeMatch[1].toLowerCase();
  const authorityStart = schemeMatch[0].length;
  const rest = input.slice(authorityStart);
  const authorityEndOffset = rest.search(AUTHORITY_END_PATTERN);
  const authorityEnd = authorityEndOffset === -1 ? input.length : authorityStart + authorityEndOffset;
  const authority = input.slice(authorityStart, authorityEnd);

  if (!authority) {
    throw new Error("Input URL must include a host");
  }

  const normalizedAuthority = normalizeAuthorityHost(authority);
  const suffix = input.slice(authorityEnd);
  const normalizedUrl = `${scheme}://${normalizedAuthority}${suffix}`;

  assertSupportedCharacters(normalizedUrl);

  return scheme === "https"
    ? { normalizedUrl, body: `${normalizedAuthority}${suffix}`, scheme, httpsOmitted: true }
    : { normalizedUrl, body: normalizedUrl, scheme, httpsOmitted: false };
}

function normalizeAuthorityHost(authority: string): string {
  const atIndex = authority.lastIndexOf("@");
  const userinfo = atIndex === -1 ? "" : authority.slice(0, atIndex + 1);
  const hostPort = atIndex === -1 ? authority : authority.slice(atIndex + 1);

  if (!hostPort) {
    throw new Error("Input URL must include a host after userinfo");
  }

  if (hostPort.startsWith("[")) {
    const closeIndex = hostPort.indexOf("]");
    if (closeIndex === -1) throw new Error("Invalid bracketed host");

    const host = hostPort.slice(0, closeIndex + 1).toLowerCase();
    const port = hostPort.slice(closeIndex + 1);
    return `${userinfo}${host}${port}`;
  }

  const portStart = findPortStart(hostPort);
  const host = portStart === -1 ? hostPort : hostPort.slice(0, portStart);
  const port = portStart === -1 ? "" : hostPort.slice(portStart);

  return `${userinfo}${host.toLowerCase()}${port}`;
}

function findPortStart(hostPort: string): number {
  const colonIndex = hostPort.lastIndexOf(":");
  if (colonIndex === -1) return -1;

  return /^\d+$/.test(hostPort.slice(colonIndex + 1)) ? colonIndex : -1;
}

function assertSupportedCharacters(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      throw new Error("Input URL must not contain ASCII control characters");
    }
  }
}
