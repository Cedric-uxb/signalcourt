import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ARTICLE_CHARACTERS = 40_000;

export type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;

  const [a = 0, b = 0, c = 0] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) return null;

  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }

  const words = [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word, 16));

  return words.length === 8 && words.every((word) => Number.isFinite(word))
    ? words
    : null;
}

function isPublicIpv6(address: string): boolean {
  const words = expandIpv6(address);
  if (!words) return false;

  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = words;
  const isIpv4Mapped = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
  if (isIpv4Mapped) return false;

  const isGlobalUnicast = (a & 0xe000) === 0x2000;
  const isIetfSpecial = a === 0x2001 && b <= 0x01ff;
  const isDocumentation =
    (a === 0x2001 && b === 0x0db8) ||
    (a === 0x3fff && (b & 0xf000) === 0);
  const isSixToFour = a === 0x2002;

  return isGlobalUnicast && !isIetfSpecial && !isDocumentation && !isSixToFour;
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function normalizedHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

export async function assertPublicHttpUrl(
  raw: string,
  lookupImpl: DnsLookup = lookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error("Article URL is invalid", { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) article URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("Article URLs must not contain credentials");
  }
  if (url.hostname.endsWith(".")) {
    throw new Error("Article URL hostname must not have a trailing dot");
  }

  const hostname = normalizedHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Non-public network destinations are blocked");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!isPublicIp(hostname)) {
      throw new Error("Non-public network destinations are blocked");
    }
    return url;
  }

  let addresses: ReadonlyArray<{ address: string; family: number }>;
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`DNS lookup failed for ${hostname}`, { cause: error });
  }

  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${hostname}`);
  }
  if (addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("Non-public network destinations are blocked");
  }

  return url;
}

function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return text.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|nbsp|quot));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (named) return namedEntities[named.toLowerCase()] ?? entity;

      const codePoint = Number.parseInt(decimal ?? hexadecimal ?? "", hexadecimal ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return entity;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return entity;
      return String.fromCodePoint(codePoint);
    },
  );
}

export function extractArticleText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ARTICLE_CHARACTERS);
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error("Article response is too large");
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel("Article response is too large");
        throw new Error("Article response is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function fetchArticle(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  lookupImpl: DnsLookup = lookup,
): Promise<{ url: string; text: string }> {
  const url = await assertPublicHttpUrl(rawUrl, lookupImpl);

  // DNS is checked before fetch; without a pinned dispatcher, a theoretical rebind window remains.
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Article fetch failed with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/html(?:\s*;|$)/i.test(contentType)) {
    throw new Error("Article response must be HTML");
  }

  return {
    url: url.toString(),
    text: extractArticleText(await readLimitedText(response)),
  };
}
