/**
 * Bookmark metadata.
 *
 * Deliberately dependency-free: a bookmark card needs a title, a description
 * and a favicon, and those are three regexes over the first slice of the HTML.
 * A real HTML parser would buy correctness we do not need — anything that fails
 * to match simply leaves the card showing the domain, which is also what Notion
 * does for pages it cannot read.
 *
 * The result is stored in the block payload by the renderer, so a bookmark
 * still renders with its title and description when the machine is offline.
 */
import { UrlMeta } from "../shared/ipc";

const TIMEOUT_MS = 5000;
/** Metadata lives in <head>; reading further wastes time on large pages. */
const MAX_BYTES = 256 * 1024;

function decodeEntities(value: string): string {
  return value
    .replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      return named[entity.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const text = decodeEntities(value);
  if (text === "") return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** First capture group of the first pattern that matches. */
function firstMatch(html: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1] !== undefined && match[1].trim() !== "") return match[1];
  }
  return undefined;
}

function metaContent(html: string, names: string[]): string | undefined {
  return firstMatch(
    html,
    names.flatMap((name) => [
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`,
        "i",
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`,
        "i",
      ),
    ]),
  );
}

export function parseUrlMeta(html: string, url: string): UrlMeta {
  const title =
    clean(metaContent(html, ["og:title", "twitter:title"]), 160) ??
    clean(firstMatch(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]), 160);
  const description = clean(
    metaContent(html, ["og:description", "twitter:description", "description"]),
    280,
  );

  const iconHref = firstMatch(html, [
    /<link[^>]+rel=["'][^"']*\bicon\b[^"']*["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*\bicon\b[^"']*["']/i,
  ]);
  let favicon: string | null = null;
  try {
    favicon = new URL(iconHref ?? "/favicon.ico", url).toString();
  } catch {
    favicon = null;
  }

  return { url, title, description, favicon };
}

export async function fetchUrlMeta(rawUrl: string): Promise<UrlMeta> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { url: rawUrl, title: null, description: null, favicon: null };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { url: url.toString(), title: null, description: null, favicon: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Kumi/0.1" },
    });
    if (!response.ok || !response.body) {
      return { url: url.toString(), title: null, description: null, favicon: null };
    }
    const buffer = await response.arrayBuffer();
    const html = new TextDecoder("utf-8", { fatal: false }).decode(
      buffer.byteLength > MAX_BYTES ? buffer.slice(0, MAX_BYTES) : buffer,
    );
    return parseUrlMeta(html, response.url !== "" ? response.url : url.toString());
  } catch {
    return { url: url.toString(), title: null, description: null, favicon: null };
  } finally {
    clearTimeout(timer);
  }
}
