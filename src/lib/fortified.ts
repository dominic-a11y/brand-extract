/**
 * Browser-infra primitives — the "fortified" Playwright layer that
 * `extractBrand` uses internally and that external callers (e.g. byrk's
 * scrape pipeline) can plug into in place of raw `chromium.launch +
 * browser.newContext + page.goto`.
 *
 * Design intent: this layer concerns itself ONLY with browser hardening
 * and safe navigation:
 *   - stealth-patched Chromium (defeats most fingerprint bot detection)
 *   - cookie / consent / GDPR popup dismissal (autoconsent + walk-up
 *     CSS fallback for unknown CMPs)
 *   - .catch fallthrough on goto so partial DOM beats no DOM
 *
 * It does NOT extract anything. Caller runs whatever extraction logic
 * (products, logos, screenshots, sanitized text, …) on the Page after
 * `fortifiedGoto` resolves. This is by design — extraction code is
 * domain-specific and lives with the consumer.
 */

import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "playwright";
import { runAutoconsent } from "./autoconsent.js";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export interface FortifiedGotoOptions {
  /**
   * Playwright nav wait strategy. Default `"networkidle"` matches the
   * extractBrand default. Pass `"domcontentloaded"` for sites that
   * never go quiet (analytics, chat widgets, infinite-poll SPAs).
   */
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  /** Nav timeout. Default 20_000 ms. Failures are caught — never thrown. */
  timeout?: number;
  /**
   * Extra wait after navigation completes (or times out), before cookie
   * dismissal. Lets SPA hydration / lazy content settle. Default 0 ms.
   */
  additionalWaitMs?: number;
  /**
   * Skip cookie / consent / GDPR popup dismissal. Useful when the caller
   * needs the raw, untouched DOM (e.g. archival, legal-evidence capture).
   * Default false.
   */
  skipCookieHide?: boolean;
}

export interface FortifiedGotoResult {
  /** True if `page.goto` resolved without throwing. False if the nav
   *  timed out or errored (page may still be usable for partial extract). */
  navOk: boolean;
}

/**
 * Create a new Playwright BrowserContext with sensible defaults.
 *
 * All Playwright `BrowserContextOptions` pass through, so callers can
 * override viewport, deviceScaleFactor, userAgent, locale, etc. Only
 * a default viewport is supplied if the caller didn't specify one.
 */
export async function createFortifiedContext(
  browser: Browser,
  opts: BrowserContextOptions = {},
): Promise<BrowserContext> {
  return await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    ...opts,
  });
}

/**
 * Navigate to `url` with fail-tolerance and post-nav cookie dismissal.
 *
 * Order of operations:
 *   1. `page.goto(url, { waitUntil, timeout })` — nav errors are caught
 *      and logged; navOk=false signals the caller may have a partial DOM
 *   2. Optional `additionalWaitMs` settle delay
 *   3. Autoconsent injection (skipped if `skipCookieHide`) — clicks the
 *      "reject all" button on detected CMPs (OneTrust, Cookiebot, …)
 *   4. ~500 ms grace for click-driven DOM mutations
 *   5. Walk-up CSS fallback — finds any cookie/consent/gdpr element,
 *      ascends to the nearest fixed/absolute-positioned ancestor with
 *      meaningful area, and `display: none`s it. Catches CMPs that
 *      autoconsent has no rule for (Shopify-style nested drawers, …)
 *
 * Why post-nav and not pre-nav: `page.exposeFunction` (used by autoconsent
 * for the page↔Node bridge) adds a `window.autoconsentSendMessage` property
 * that fingerprint-based bot detection (Akamai et al.) flags. Setting it
 * up before the first nav makes anti-bot serve a deflection page. By
 * waiting until after nav, the binding doesn't affect the served content.
 */
export async function fortifiedGoto(
  page: Page,
  url: string,
  opts: FortifiedGotoOptions = {},
): Promise<FortifiedGotoResult> {
  const waitUntil = opts.waitUntil ?? "networkidle";
  const timeout = opts.timeout ?? 20_000;

  let navOk = true;
  await page.goto(url, { waitUntil, timeout }).catch((err) => {
    console.warn(
      "[brand-extract] nav failed, continuing with partial",
      err instanceof Error ? err.message : err,
    );
    navOk = false;
  });

  if (opts.additionalWaitMs && opts.additionalWaitMs > 0) {
    await page.waitForTimeout(opts.additionalWaitMs).catch(() => {});
  }

  if (!opts.skipCookieHide) {
    await runAutoconsent(page).catch((err) => {
      console.warn(
        "[brand-extract] autoconsent failed",
        err instanceof Error ? err.message : err,
      );
    });
    await page.waitForTimeout(500).catch(() => {});

    // Walk-up CSS fallback for CMPs autoconsent has no rule for.
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
  }

  return { navOk };
}
