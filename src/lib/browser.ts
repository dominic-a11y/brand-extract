import type { Browser } from "playwright";
// playwright-extra wraps the playwright Chromium launcher and lets us register
// stealth patches (navigator.webdriver, plugins, audio context, JA3 quirks…)
// to defeat headless-fingerprint bot detection (Akamai / DataDome / PerimeterX).
// `puppeteer-extra-plugin-stealth` is plugin-API-compatible with playwright-extra
// despite the name.
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

/**
 * Launch a fresh stealth-patched Chromium. Caller owns the lifecycle —
 * remember to `await browser.close()` when done.
 *
 * Use this when you want to manage your own Browser (batch jobs, custom
 * lifecycle, multiple browsers in parallel). For a singleton convenience
 * see `getBrowser()` / `closeBrowser()` below.
 */
export async function launchFortifiedBrowser(
  opts: { headless?: boolean } = {},
): Promise<Browser> {
  return (await chromium.launch({
    headless: opts.headless ?? true,
  })) as Browser;
}

/**
 * Lazily-launched headless-Chromium singleton with stealth patches applied.
 *
 * Library callers can either:
 *   - let `extractBrand` launch+close per call (simple, slower per-call)
 *   - call `getBrowser()` once, reuse for many calls, then `closeBrowser()`
 *     at shutdown (4–6× faster for batch jobs)
 */
let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (_browser) return _browser;
  _browser = await launchFortifiedBrowser();
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (!_browser) return;
  await _browser.close();
  _browser = null;
}
