import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  assertPublicHttpUrl,
  extractArticleText,
  fetchArticle,
  type DnsLookup,
} from "./article-fetcher.js";

const fixtureUrl = new URL("../../../tests/fixtures/article.html", import.meta.url);

function lookupReturning(...addresses: string[]): DnsLookup {
  return vi.fn(async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })),
  );
}

describe("assertPublicHttpUrl", () => {
  it.each(["file:///etc/passwd", "ftp://example.com/file"])(
    "rejects unsupported protocol in %s",
    async (rawUrl) => {
      await expect(assertPublicHttpUrl(rawUrl, lookupReturning("8.8.8.8"))).rejects.toThrow(
        /HTTP\(S\)/,
      );
    },
  );

  it.each([
    "https://user@example.com/article",
    "https://user:password@example.com/article",
  ])("rejects credentials in %s", async (rawUrl) => {
    await expect(assertPublicHttpUrl(rawUrl, lookupReturning("8.8.8.8"))).rejects.toThrow(
      /credentials/i,
    );
  });

  it.each(["http://localhost/admin", "http://LOCALHOST./admin"])(
    "rejects normalized localhost hostname %s",
    async (rawUrl) => {
      const lookupImpl = lookupReturning("8.8.8.8");

      await expect(assertPublicHttpUrl(rawUrl, lookupImpl)).rejects.toThrow(/blocked/i);
      expect(lookupImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://127.0.0.1/admin",
    "http://0.0.0.0/",
    "http://10.0.0.2/private",
    "http://172.31.0.1/private",
    "http://192.168.1.1/private",
    "http://169.254.10.1/metadata",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://192.0.2.1/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://[::]/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[2001:db8::1]/",
    "http://[ff02::1]/",
    "http://[::ffff:192.168.1.1]/",
  ])("rejects non-public IP literal %s", async (rawUrl) => {
    const lookupImpl = lookupReturning("8.8.8.8");

    await expect(assertPublicHttpUrl(rawUrl, lookupImpl)).rejects.toThrow(/blocked/i);
    expect(lookupImpl).not.toHaveBeenCalled();
  });

  it("rejects a domain resolving to a private address", async () => {
    await expect(
      assertPublicHttpUrl("https://news.example/article", lookupReturning("10.2.3.4")),
    ).rejects.toThrow(/blocked/i);
  });

  it("rejects mixed public and private DNS answers", async () => {
    await expect(
      assertPublicHttpUrl(
        "https://news.example/article",
        lookupReturning("8.8.8.8", "192.168.1.20"),
      ),
    ).rejects.toThrow(/blocked/i);
  });

  it("accepts multiple public DNS answers with all and verbatim lookup options", async () => {
    const lookupImpl = lookupReturning("8.8.8.8", "2001:4860:4860::8888");

    await expect(assertPublicHttpUrl("https://NEWS.example./story", lookupImpl)).resolves.toEqual(
      new URL("https://news.example./story"),
    );
    expect(lookupImpl).toHaveBeenCalledWith("news.example", {
      all: true,
      verbatim: true,
    });
  });

  it("rejects an empty DNS answer", async () => {
    await expect(
      assertPublicHttpUrl("https://news.example/article", lookupReturning()),
    ).rejects.toThrow(/no addresses/i);
  });

  it("reports DNS lookup failures clearly", async () => {
    const lookupImpl: DnsLookup = vi.fn(async () => {
      throw new Error("resolver unavailable");
    });

    await expect(assertPublicHttpUrl("https://news.example/article", lookupImpl)).rejects.toThrow(
      /DNS lookup failed for news\.example/,
    );
  });
});

describe("extractArticleText", () => {
  it("extracts normalized text from the article fixture", async () => {
    const html = await readFile(fixtureUrl, "utf8");

    expect(extractArticleText(html)).toBe(
      "Ignored page title Bitcoin & Ether update Issuer confirms the filing & market response. <Verified> 'today' \"officially\".",
    );
  });

  it("caps extracted text at 40,000 characters", () => {
    expect(extractArticleText(`<p>${"a".repeat(45_000)}</p>`)).toHaveLength(40_000);
  });
});

describe("fetchArticle", () => {
  it("uses redirect error mode, a timeout signal, and returns extracted HTML text", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("<article><h1>Headline</h1><p>Body.</p></article>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    await expect(
      fetchArticle(
        "https://news.example/story",
        fetchImpl,
        lookupReturning("8.8.8.8"),
      ),
    ).resolves.toEqual({
      url: "https://news.example/story",
      text: "Headline Body.",
    });

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl).toEqual(new URL("https://news.example/story"));
    expect(init).toMatchObject({ redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects redirect responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/story" },
        }),
    );

    await expect(
      fetchArticle("https://news.example/story", fetchImpl, lookupReturning("8.8.8.8")),
    ).rejects.toThrow(/302/);
  });

  it("rejects non-success status codes", async () => {
    const fetchImpl = vi.fn(async () => new Response("missing", { status: 404 }));

    await expect(
      fetchArticle("https://news.example/story", fetchImpl, lookupReturning("8.8.8.8")),
    ).rejects.toThrow(/404/);
  });

  it("rejects non-HTML content", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      fetchArticle("https://news.example/story", fetchImpl, lookupReturning("8.8.8.8")),
    ).rejects.toThrow(/HTML/i);
  });

  it("rejects a streamed response larger than 512 KiB", async () => {
    const oversizedBody = new Uint8Array(512 * 1024 + 1).fill(97);
    const fetchImpl = vi.fn(
      async () =>
        new Response(oversizedBody, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    await expect(
      fetchArticle("https://news.example/story", fetchImpl, lookupReturning("8.8.8.8")),
    ).rejects.toThrow(/too large/i);
  });
});
