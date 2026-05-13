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
  Response,
} from "playwright";
import { runAutoconsent } from "./autoconsent.js";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export interface FortifiedGotoOptions {
  /**
   * Playwright nav wait strategy. Default `"domcontentloaded"` —
   * `"networkidle"` is too brittle on real sites: heavy SPAs with
   * analytics / chat widgets / poll-based features rarely go quiet
   * within any reasonable timeout, so the nav fails over to .catch
   * fallthrough and we screenshot a half-rendered page anyway.
   * `"domcontentloaded"` fires sooner + the `additionalWaitMs` default
   * gives hydration a moment. Pass `"networkidle"` explicitly if you
   * really need the network to be quiet.
   */
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  /** Nav timeout. Default 20_000 ms. Failures are caught — never thrown. */
  timeout?: number;
  /**
   * Extra wait after navigation completes (or times out), before cookie
   * dismissal. Lets SPA hydration / lazy content settle. Default
   * 1500 ms — empirically enough for most marketing sites to render
   * above-the-fold content + populate first-paint product imagery.
   * Set to 0 to skip if you need fastest-possible turnaround.
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
  /**
   * The Playwright `Response` from `page.goto`. Null when `navOk` is
   * false, when the navigation didn't produce a response (e.g.
   * about:blank), or when the same-document navigation hook fired.
   * Use `response?.ok()` to detect 4xx/5xx without re-fetching.
   */
  response: Response | null;
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
  const waitUntil = opts.waitUntil ?? "domcontentloaded";
  const timeout = opts.timeout ?? 20_000;
  const additionalWaitMs = opts.additionalWaitMs ?? 1500;

  let navOk = true;
  let response: Response | null = null;
  response = await page.goto(url, { waitUntil, timeout }).catch((err) => {
    console.warn(
      "[brand-extract] nav failed, continuing with partial",
      err instanceof Error ? err.message : err,
    );
    navOk = false;
    return null;
  });

  if (additionalWaitMs > 0) {
    await page.waitForTimeout(additionalWaitMs).catch(() => {});
  }

  if (!opts.skipCookieHide) {
    await runAutoconsent(page).catch((err) => {
      console.warn(
        "[brand-extract] autoconsent failed",
        err instanceof Error ? err.message : err,
      );
    });
    await page.waitForTimeout(500).catch(() => {});

    // Walk-up fallback for CMPs autoconsent has no rule for. Two passes:
    //   (1) Walk-up: ascend from any cookie/consent-hinted element to the
    //       nearest fixed/absolute-positioned ancestor and remove it.
    //       Catches Shopify-style nested drawers where the named element
    //       is buried inside an unnamed wrapper.
    //   (2) Direct: also remove the hinted elements themselves. Catches
    //       text-cleanup cases — autoconsent's prehide CSS often hides
    //       elements via display:none, which leaves them in the DOM for
    //       page.content() / sanitized-text consumers to pick up. .remove()
    //       at the source ensures both the visual AND the text are clean.
    await page
      .evaluate(() => {
        const HINT =
          // Direct cookie/consent/GDPR hints
          '[id*="cookie" i],[class*="cookie" i],' +
          '[id*="consent" i],[class*="consent" i],' +
          '[id*="gdpr" i],[class*="gdpr" i],' +
          '[aria-label*="cookie" i],[aria-label*="consent" i],' +
          // Common CMPs that don't include "cookie" / "consent" in element naming
          '[id*="shopify-pc" i],[class*="shopify-pc" i],' + // Shopify Privacy Center
          '[id*="onetrust" i],[class*="onetrust" i],' + // OneTrust SDK
          '[id*="cookiebot" i],[class*="cookiebot" i],' + // Cookiebot
          '[id*="usercentrics" i],[class*="usercentrics" i],' + // Usercentrics
          '[id*="truste" i],[class*="truste" i],' + // TrustArc
          // Geo-redirect / "select your country" interstitials. These obscure
          // the brand surface for the same downstream-LLM reason as cookie
          // banners (Apple, Nike, Sephora, Gymshark all serve them on first
          // visit from a foreign IP). Selectors are intentionally specific —
          // generic "country" / "region" / "locale" would catch nav-bar
          // locale switchers and currency dropdowns. The walk-up + size
          // guard provides additional protection against false positives.
          '[id*="region-select" i],[class*="region-select" i],' +
          '[id*="region-redirect" i],[class*="region-redirect" i],' +
          '[id*="region-modal" i],[class*="region-modal" i],' +
          '[id*="country-select" i],[class*="country-select" i],' +
          '[id*="country-redirect" i],[class*="country-redirect" i],' +
          '[id*="country-modal" i],[class*="country-modal" i],' +
          '[id*="geo-redirect" i],[class*="geo-redirect" i],' +
          '[id*="geo-modal" i],[class*="geo-modal" i],' +
          '[id*="geo-popup" i],[class*="geo-popup" i],' +
          '[id*="locale-redirect" i],[class*="locale-redirect" i],' +
          '[id*="ship-to" i],[class*="ship-to" i]';
        const matches = Array.from(document.querySelectorAll(HINT));

        // Pass 1: walk-up + remove visual container.
        const removed = new Set<Element>();
        matches.forEach((el) => {
          let cur: Element | null = el;
          for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
            const cs = getComputedStyle(cur);
            if (cs.position === "fixed" || cs.position === "absolute") {
              const r = cur.getBoundingClientRect();
              // Keep the size guard for visible elements — protects against
              // false positives like a small "manage cookies" footer link
              // that happens to live inside a positioned tooltip wrapper.
              // For autoconsent-hidden elements (zero rect) the guard fails
              // safely; pass 2 below catches the text instead.
              if (r.width > 80 && r.height > 40 && !removed.has(cur)) {
                removed.add(cur);
                cur.remove();
              }
              break;
            }
            cur = cur.parentElement;
          }
        });

        // Pass 2: remove the hinted elements themselves (those still attached).
        // No size guard — these matched our specific cookie/consent/gdpr
        // selector, so the false-positive risk is low.
        matches.forEach((el) => {
          if (el.isConnected) el.remove();
        });

        // Pass 3: content-based geo-redirect dismissal. Sites built on
        // CSS-in-JS (Emotion, styled-components, etc.) have hash-based
        // class names that no selector can target — Sephora's geo-modal
        // is e.g. `<div role="dialog" class="css-425ijq">`. The only
        // reliable marker is the user-facing copy. Match dialogs/role=
        // alertdialog elements containing distinctive geo-redirect
        // phrases, then walk up to the positioned ancestor and remove.
        const GEO_PHRASES = [
          "trying to access",
          "ship to your country",
          "ship to this country",
          "doesn't ship to",
          "does not ship to",
          "international site",
          "international websites",
          "international version",
          "select your country",
          "select your region",
          "select your location",
          "choose your country",
          "choose your region",
          "you're in",
          "you are in",
          "another country",
          "different country",
        ];
        const dialogs = document.querySelectorAll<HTMLElement>(
          '[role="dialog"],[role="alertdialog"]',
        );
        dialogs.forEach((dlg) => {
          const text = (dlg.textContent ?? "").toLowerCase();
          if (!GEO_PHRASES.some((p) => text.includes(p))) return;
          // Walk up to the nearest fixed/absolute ancestor (the actual
          // visible overlay container — dialog itself is often relative
          // inside a fixed wrapper).
          let cur: Element | null = dlg;
          for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
            const cs = getComputedStyle(cur);
            if (cs.position === "fixed" || cs.position === "absolute") {
              cur.remove();
              return;
            }
            cur = cur.parentElement;
          }
          // No positioned ancestor found — remove the dialog itself.
          dlg.remove();
        });
      })
      .catch(() => {});
  }

  return { navOk, response };
}
