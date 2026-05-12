# brand-extract

> URL → brand tokens + meta + screenshot. Fail-tolerant Playwright + [dembrandt](https://www.npmjs.com/package/dembrandt) scraper.

Lifted from the [adgen](https://github.com/dominic-a11y/adgen) pipeline and packaged as a standalone library + CLI. Designed to **gracefully partial-fail** on hostile pages (Cloudflare-fronted DTC sites, heavy SPAs, anti-bot) instead of throwing.

## Pipeline

```
URL  →  ┌─ dembrandt CLI ────────→  design tokens (palette, type, logo, favicons)
        │  (60s timeout, returns null on fail)
        │
        └─ Playwright Chromium ──→  meta + viewport screenshot
                                    + (opt) html / sanitized text / logo / subpage shots
           (20s nav timeout, .catch() fallthrough)

Both tracks run in parallel. Failures in one never block the other.
```

## Install

```bash
npm install
npx playwright install chromium    # ~150MB one-time
```

## CLI

```
brand-extract <url> [options]

  --json                Print full result as JSON (buffers base64-encoded)
  --screenshot <path>   Write the viewport screenshot to <path>
  --thorough            Enable captureHtml + captureSanitizedText + captureLogo
                        + fetchLogo + captureSubpages=3
  --help, -h            Show this help
```

```bash
# Fast / robust mode (default) — palette, meta, viewport screenshot
brand-extract https://stripe.com

# Thorough mode — captures everything byrk's scraper grabs
brand-extract https://gymshark.com --thorough --json > result.json

# Save viewport screenshot to disk
brand-extract https://supreme.com/shop --screenshot ./supreme.png
```

## Library

```ts
import { extractBrand } from "brand-extract";

// Fast / robust (default)
const r = await extractBrand("https://stripe.com");
//  → { url, raw, meta, screenshot, html: null, sanitizedText: null, logo: null, subpages: [] }

// Thorough — byrk-equivalent capture
const r = await extractBrand("https://stripe.com", {
  captureHtml: true,
  captureSanitizedText: true,
  captureLogo: true,
  fetchLogo: true,        // also downloads the logo URL into a Buffer
  captureSubpages: 3,     // navs to first 3 about/product/pricing links
});

// Reuse a browser across many calls (4–6× faster batch)
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
  for (const url of urls) {
    const r = await extractBrand(url, { browser });
    // ...
  }
} finally {
  await browser.close();
}
```

## Use as browser-infra (primitives only)

`extractBrand()` is a one-shot convenience. If you already have your own
extraction pipeline (product objects, multi-tier logo fallback, sanitizer,
Apify fallback, etc.) and you only want the **fortified browser layer**
underneath — stealth + autoconsent + walk-up cookie hide + fail-tolerant
nav — three primitives are exported:

```ts
import {
  launchFortifiedBrowser,
  createFortifiedContext,
  fortifiedGoto,
} from "brand-extract";

const browser = await launchFortifiedBrowser();             // stealth chromium
const ctx = await createFortifiedContext(browser, {         // pass-through opts
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  userAgent: "Mozilla/5.0 (Macintosh; …) Chrome/131.0.0.0 Safari/537.36",
  locale: "en-US",
});
const page = await ctx.newPage();

await fortifiedGoto(page, "https://kitkat.com", {
  waitUntil: "domcontentloaded",
  timeout: 30_000,
  additionalWaitMs: 2_000,    // SPA hydration grace
});

// Now the page is loaded with stealth fingerprint + cookie banners
// dismissed. Everything below is YOUR code:
const html = await page.content();
const png = await page.screenshot({ fullPage: true });
const products = await yourExtractProducts(page);
const logo = await yourMultiTierLogoExtract(page);
// …

await browser.close();
```

This is the integration model byrk uses internally — the existing scrape
pipeline keeps its product/logo/sanitizer/fallback logic untouched, and
only the browser+nav substrate is swapped for the fortified primitives.

## API

### `extractBrand(url, options?) → ExtractionResult`

### `ExtractOptions`

| Field | Default | What it does |
|---|---|---|
| `dembrandtTimeoutMs` | `60_000` | dembrandt subprocess timeout |
| `pageLoadTimeoutMs` | `20_000` | `page.goto()` timeout |
| `pages` | `3` | dembrandt `--pages` (internal crawl count) |
| `viewport` | `1280×800` | Playwright viewport + screenshot size |
| `skipScreenshot` | `false` | Skip the viewport screenshot |
| `browser` | — | Reuse a Playwright Browser instead of launching one per call |
| **Thorough mode** (all opt-in) | | |
| `captureHtml` | `false` | Include full rendered HTML in result |
| `captureSanitizedText` | `false` | Strip `<script>` / `<style>` / tags + collapse whitespace |
| `captureLogo` | `false` | Find largest `<img>` in `<header>` (favicon fallback) |
| `fetchLogo` | `false` | Download `logo.url` to a Buffer (requires `captureLogo`) |
| `captureSubpages` | `0` | Number of subpages to navigate + screenshot (max 5) |
| `subpagePatterns` | about/product/pricing | RegExp list to match subpage `href`s |
| `subpageNavTimeoutMs` | `12_000` | Per-subpage nav timeout |

### `ExtractionResult`

```ts
interface ExtractionResult {
  url: string;
  raw: DembrandtRaw | null;             // null if dembrandt failed
  meta: PageMetadata;                    // always present, fields may be null
  screenshot: Buffer | null;             // null if skipped or capture failed
  html: string | null;
  sanitizedText: string | null;
  logo: { url: string; buffer: Buffer | null } | null;
  subpages: Array<{ url: string; screenshot: Buffer | null }>;
}
```

## Design rules

1. **Every capture in its own `try/catch`.** One sub-failure never breaks the rest. Recoverable errors are logged with `console.warn` and the field is set to `null`. `extractBrand()` never throws on a normal nav / extract failure.
2. **Storage is decoupled.** Library returns Buffers + URLs only. Caller decides where to upload (R2, S3, fs, etc.).
3. **Defaults are fast and robust.** Thorough-mode captures are purely opt-in. `extractBrand(url)` with no options is the fastest, most-resilient call.

These rules are why this scraper handles hostile URLs (Cloudflare-fronted, heavy SPAs) better than naive `page.goto + page.content` implementations.

## Compared to byrk.io's homegrown scraper

| | byrk's `scrape.ts` | brand-extract |
|---|---|---|
| User agent | Self-ID bot UA (blocked by many sites) | Playwright default Chromium UA |
| Nav failure | `page.goto` without `.catch()` → throws, kills job | `.catch(() => {})` → partial result |
| Screenshot | `fullPage: true` (forces lazy-loads) | Viewport only (fast) |
| Total budget | `maxDuration: 30s` for the whole task | 60s dembrandt + 20s Playwright in parallel |
| Failure mode | All-or-nothing | Graceful partial |
| Brand tokens | Done later by LLM on raw HTML | dembrandt subprocess inline |

## Notes

- `dembrandt`'s CLI flags assumed: `--json-only` and `--pages <n>`. Verify with `npx dembrandt --help` before relying on them.
- `dembrandt` may return `null` (subprocess failed). Downstream callers must handle a missing `raw` field.
- The lib launches a Chromium instance per call by default. For batch scraping, pass a shared `browser` for ~4–6× speedup.

## License

MIT
