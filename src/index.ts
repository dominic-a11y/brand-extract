/**
 * brand-extract — URL → brand tokens + meta + screenshot.
 *
 * Two-track parallel scrape:
 *   1. `dembrandt` CLI subprocess → design tokens (palette, type, logo)
 *   2. Playwright Chromium → meta + viewport screenshot + (opt) html, logo,
 *      subpage screenshots
 *
 * Three design rules:
 *   - Every capture in its own try/catch — one failing never breaks the rest
 *   - Storage decoupled — returns Buffers + URLs, caller stores where it likes
 *   - Defaults stay fast + robust — thorough-mode captures are purely opt-in
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright";
import { getBrowser, closeBrowser } from "./lib/browser.js";
import {
  createFortifiedContext,
  fortifiedGoto,
} from "./lib/fortified.js";
import { runAutoconsent } from "./lib/autoconsent.js";
import type {
  DembrandtRaw,
  ExtractionResult,
  ExtractOptions,
  PageMetadata,
} from "./lib/types.js";

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  dembrandtTimeoutMs: 60_000,
  pageLoadTimeoutMs: 20_000,
  pages: 3,
  viewport: { width: 1280, height: 800 },
  subpagePatterns: [
    /\/about|company|story/i,
    /\/product|features|how-it-works/i,
    /\/pricing|plans/i,
  ] as RegExp[],
  subpageNavTimeoutMs: 12_000,
  maxSubpages: 5,
};

// ─── dembrandt subprocess ──────────────────────────────────────────────────

async function runDembrandt(
  url: string,
  pages: number,
  timeoutMs: number,
): Promise<DembrandtRaw | null> {
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["dembrandt", url, "--json-only", "--pages", String(pages)],
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as DembrandtRaw;
  } catch (err) {
    console.warn(
      "[brand-extract] dembrandt failed",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ─── HTML sanitizer (no deps; ~25 LOC) ─────────────────────────────────────

function sanitizeHtml(html: string): string {
  let s = html;
  // Strip <script>...</script> and <style>...</style>
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  // Strip HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, " ");
  // Decode the common entities
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// ─── Per-page capture — meta + screenshot + opt-in thorough captures ───────

type CaptureOpts = {
  pageLoadTimeoutMs: number;
  viewport: { width: number; height: number };
  skipScreenshot: boolean;
  captureHtml: boolean;
  captureSanitizedText: boolean;
  captureLogo: boolean;
  fetchLogo: boolean;
  captureSubpages: number;
  subpagePatterns: RegExp[];
  subpageNavTimeoutMs: number;
};

async function captureFromPage(
  browser: Browser,
  url: string,
  opts: CaptureOpts,
): Promise<Omit<ExtractionResult, "url" | "raw">> {
  const ctx: BrowserContext = await createFortifiedContext(browser, {
    viewport: opts.viewport,
  });
  const page: Page = await ctx.newPage();

  let meta: PageMetadata = {
    title: null,
    description: null,
    headings: [],
    ogImage: null,
    productImages: [],
  };
  let screenshot: Buffer | null = null;
  let html: string | null = null;
  let sanitizedText: string | null = null;
  let logo: { url: string; buffer: Buffer | null } | null = null;
  const subpages: Array<{ url: string; screenshot: Buffer | null }> = [];

  try {
    // Nav with .catch fallthrough — partial result > no result. Cookie
    // dismissal is deferred until AFTER meta extract so we don't leak
    // autoconsent's window binding before anti-bot fingerprinting runs.
    await fortifiedGoto(page, url, {
      waitUntil: "networkidle",
      timeout: opts.pageLoadTimeoutMs,
      skipCookieHide: true,
    });

    // ─── meta (title, description, headings, og:image, productImages) ──
    // Runs BEFORE autoconsent so the page world still has a clean
    // fingerprint — anti-bot systems (Akamai et al.) decide which page
    // to serve on first nav, and `page.exposeFunction` adds a window
    // binding they detect. Order: nav → meta → autoconsent → screenshot.
    try {
      meta = await page.evaluate((): PageMetadata => {
        const get = (sel: string): string | null => {
          const el = document.querySelector<HTMLMetaElement>(sel);
          return el?.content?.trim() || null;
        };

        const headings = Array.from(document.querySelectorAll("h1, h2"))
          .slice(0, 10)
          .map((el) => (el.textContent ?? "").trim())
          .filter(Boolean);

        function collectProductImages(): string[] {
          const candidates: Array<{ url: string; area: number }> = [];

          // 1) Visible <img> tags, filter by rendered size + obvious non-product hints
          for (const img of Array.from(document.querySelectorAll("img"))) {
            const rect = img.getBoundingClientRect();
            if (rect.width < 600) continue;
            const imgUrl = (img.currentSrc || img.src || "").trim();
            if (!imgUrl || imgUrl.startsWith("data:")) continue;
            if (img.closest("header, nav, footer")) continue;
            if (/logo|sprite|icon|favicon|placeholder/i.test(imgUrl)) continue;
            const aspect = rect.width / Math.max(rect.height, 1);
            if (aspect > 6 || aspect < 0.2) continue;
            candidates.push({ url: imgUrl, area: rect.width * rect.height });
          }

          // 2) JSON-LD Product images (synthetic large area so they win the sort)
          for (const script of Array.from(
            document.querySelectorAll('script[type="application/ld+json"]'),
          )) {
            try {
              const data = JSON.parse(script.textContent ?? "{}");
              const items: unknown[] = Array.isArray(data) ? data : [data];
              for (const item of items) {
                if (!item || typeof item !== "object") continue;
                const o = item as Record<string, unknown>;
                if (o["@type"] !== "Product") continue;
                const img = o.image;
                const urls = Array.isArray(img) ? img : [img];
                for (const u of urls) {
                  if (typeof u === "string") {
                    candidates.push({ url: u, area: 1_000_000 });
                  }
                }
              }
            } catch {
              // ignore malformed JSON-LD
            }
          }

          const seen = new Set<string>();
          const unique = candidates.filter((c) => {
            if (seen.has(c.url)) return false;
            seen.add(c.url);
            return true;
          });
          unique.sort((a, b) => b.area - a.area);
          return unique.slice(0, 5).map((c) => c.url);
        }

        return {
          title: document.title?.trim() || null,
          description:
            get('meta[name="description"]') ??
            get('meta[property="og:description"]'),
          headings,
          ogImage: get('meta[property="og:image"]'),
          productImages: collectProductImages(),
        };
      });
    } catch (err) {
      console.warn(
        "[brand-extract] meta extract failed",
        err instanceof Error ? err.message : err,
      );
    }

    // ─── dismiss cookie / consent / GDPR popups before screenshot ──────
    // Two-stage inside runAutoconsent + walk-up: autoconsent clicks the
    // reject button on rule-matched CMPs; walk-up CSS fallback hides the
    // visual container for CMPs without a rule. Both are post-nav so the
    // initial fingerprint stayed clean.
    await runAutoconsent(page).catch((err) => {
      console.warn(
        "[brand-extract] autoconsent failed",
        err instanceof Error ? err.message : err,
      );
    });
    await page.waitForTimeout(500).catch(() => {});
    await page
      .evaluate(() => {
        const HINT =
          '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i],[aria-label*="cookie" i],[aria-label*="consent" i]';
        const removed = new Set<Element>();
        document.querySelectorAll(HINT).forEach((el) => {
          let cur: Element | null = el;
          for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
            const cs = getComputedStyle(cur);
            if (cs.position === "fixed" || cs.position === "absolute") {
              const r = cur.getBoundingClientRect();
              if (r.width > 80 && r.height > 40 && !removed.has(cur)) {
                removed.add(cur);
                (cur as HTMLElement).style.setProperty(
                  "display",
                  "none",
                  "important",
                );
              }
              break;
            }
            cur = cur.parentElement;
          }
        });
      })
      .catch(() => {});

    // ─── viewport screenshot ───────────────────────────────────────────
    if (!opts.skipScreenshot) {
      try {
        screenshot = await page.screenshot({ type: "png", fullPage: false });
      } catch (err) {
        console.warn(
          "[brand-extract] screenshot failed",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ─── full HTML + sanitized text ────────────────────────────────────
    if (opts.captureHtml || opts.captureSanitizedText) {
      try {
        const content = await page.content();
        if (opts.captureHtml) html = content;
        if (opts.captureSanitizedText) sanitizedText = sanitizeHtml(content);
      } catch (err) {
        console.warn(
          "[brand-extract] html capture failed",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ─── logo ──────────────────────────────────────────────────────────
    if (opts.captureLogo) {
      try {
        const candidate = await page.evaluate((): string | null => {
          const header = document.querySelector("header");
          const imgs = Array.from(header?.querySelectorAll("img") ?? []);
          let best: HTMLImageElement | null = null;
          let bestArea = 0;
          for (const img of imgs) {
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            const area = w * h;
            if (area > bestArea && w > 0 && h > 0) {
              bestArea = area;
              best = img;
            }
          }
          if (best) return best.currentSrc || best.src || null;
          // Fallback: favicon
          const fav = document.querySelector<HTMLLinkElement>(
            'link[rel~="icon"]',
          );
          return fav?.href ?? null;
        });

        if (candidate) {
          const absUrl = new URL(candidate, url).toString();
          let buf: Buffer | null = null;
          if (opts.fetchLogo) {
            try {
              const r = await fetch(absUrl);
              if (r.ok) buf = Buffer.from(await r.arrayBuffer());
            } catch (err) {
              console.warn(
                "[brand-extract] logo fetch failed",
                err instanceof Error ? err.message : err,
              );
            }
          }
          logo = { url: absUrl, buffer: buf };
        }
      } catch (err) {
        console.warn(
          "[brand-extract] logo extract failed",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ─── subpages ──────────────────────────────────────────────────────
    const subpageMax = Math.min(
      Math.max(0, opts.captureSubpages),
      DEFAULTS.maxSubpages,
    );
    if (subpageMax > 0) {
      try {
        // Send pattern sources across the boundary (RegExp isn't serializable).
        const patternSources = opts.subpagePatterns.map((re) => re.source);
        const subpaths: string[] = await page.evaluate(
          (sources: string[]): string[] => {
            const patterns = sources.map((s) => new RegExp(s, "i"));
            const links = Array.from(
              document.querySelectorAll<HTMLAnchorElement>("a[href]"),
            );
            const found: string[] = [];
            for (const re of patterns) {
              const m = links.find((a) =>
                re.test(a.getAttribute("href") || ""),
              );
              if (m) found.push(m.href);
              if (found.length >= 5) break;
            }
            return found;
          },
          patternSources,
        );

        for (const sub of subpaths.slice(0, subpageMax)) {
          let shot: Buffer | null = null;
          try {
            await fortifiedGoto(page, sub, {
              waitUntil: "domcontentloaded",
              timeout: opts.subpageNavTimeoutMs,
            });
            shot = await page.screenshot({ type: "png", fullPage: false });
          } catch (err) {
            console.warn(
              "[brand-extract] subpage capture failed",
              sub,
              err instanceof Error ? err.message : err,
            );
          }
          subpages.push({ url: sub, screenshot: shot });
        }
      } catch (err) {
        console.warn(
          "[brand-extract] subpage discovery failed",
          err instanceof Error ? err.message : err,
        );
      }
    }
  } finally {
    await ctx.close();
  }

  return { meta, screenshot, html, sanitizedText, logo, subpages };
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function extractBrand(
  url: string,
  opts: ExtractOptions = {},
): Promise<ExtractionResult> {
  const dembrandtTimeoutMs =
    opts.dembrandtTimeoutMs ?? DEFAULTS.dembrandtTimeoutMs;
  const pageLoadTimeoutMs =
    opts.pageLoadTimeoutMs ?? DEFAULTS.pageLoadTimeoutMs;
  const pages = opts.pages ?? DEFAULTS.pages;
  const viewport = opts.viewport ?? DEFAULTS.viewport;
  const ownsBrowser = !opts.browser;
  const browser = opts.browser ?? (await getBrowser());

  const captureOpts: CaptureOpts = {
    pageLoadTimeoutMs,
    viewport,
    skipScreenshot: !!opts.skipScreenshot,
    captureHtml: !!opts.captureHtml,
    captureSanitizedText: !!opts.captureSanitizedText,
    captureLogo: !!opts.captureLogo,
    fetchLogo: !!opts.fetchLogo,
    captureSubpages: typeof opts.captureSubpages === "number" ? opts.captureSubpages : 0,
    subpagePatterns: opts.subpagePatterns ?? DEFAULTS.subpagePatterns,
    subpageNavTimeoutMs:
      opts.subpageNavTimeoutMs ?? DEFAULTS.subpageNavTimeoutMs,
  };

  try {
    const [raw, captured] = await Promise.all([
      runDembrandt(url, pages, dembrandtTimeoutMs),
      captureFromPage(browser, url, captureOpts),
    ]);
    return {
      url,
      raw,
      meta: captured.meta,
      screenshot: captured.screenshot,
      html: captured.html,
      sanitizedText: captured.sanitizedText,
      logo: captured.logo,
      subpages: captured.subpages,
    };
  } finally {
    // Only close the browser if WE launched it. Caller-owned browsers stay
    // alive for reuse across many calls.
    if (ownsBrowser) {
      await closeBrowser();
    }
  }
}

// Singleton convenience for callers that want extractBrand-style lifecycle.
export { closeBrowser, getBrowser } from "./lib/browser.js";

// Browser-infra primitives — for callers that want their own extraction
// logic on top of the stealth + cookie-hide layer (e.g. byrk's pipeline,
// where extraction code is preserved and only the browser layer is swapped).
export { launchFortifiedBrowser } from "./lib/browser.js";
export {
  createFortifiedContext,
  fortifiedGoto,
} from "./lib/fortified.js";
export type {
  FortifiedGotoOptions,
  FortifiedGotoResult,
} from "./lib/fortified.js";

export type {
  DembrandtRaw,
  DembrandtPaletteColor,
  DembrandtTypeStyle,
  DembrandtLogo,
  DembrandtFavicon,
  PageMetadata,
  ExtractionResult,
  ExtractOptions,
} from "./lib/types.js";
