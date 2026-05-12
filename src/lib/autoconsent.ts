/**
 * @duckduckgo/autoconsent integration for Playwright — POST-NAV variant.
 *
 * Why post-nav: `page.exposeFunction` adds a `window.autoconsentSendMessage`
 * property to the page world. That property is a clear "I'm an automated
 * browser" tell that fingerprint-based bot detection (Akamai, DataDome,
 * PerimeterX) picks up. If we set it up before navigation, the very first
 * page load already leaks the binding, and stealth-protected sites (e.g.
 * kitkat.com / Nestlé behind Akamai) serve us a deflection page.
 *
 * Solution: inject autoconsent ONLY after we've extracted meta from the
 * initial navigation. By that point the anti-bot has already decided
 * whether to serve us the real page; the binding can leak freely now
 * without affecting that decision. The screenshot then runs against a
 * page where autoconsent has had its chance to dismiss any CMP banner.
 *
 * Trade-off: we lose autoconsent's "prehide CSS to prevent popup flicker
 * before paint" benefit. Doesn't matter for our use case — we don't
 * screenshot mid-load.
 *
 * Subpage navigations on the same page reuse the bridge (exposeFunction
 * persists across nav). The binding will be visible on subpage loads —
 * acceptable for v0.1 (subpage anti-bot stealth is secondary to
 * homepage meta+screenshot quality).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Page } from "playwright";

const require = createRequire(import.meta.url);
const AUTOCONSENT_DIST = dirname(require.resolve("@duckduckgo/autoconsent"));

const SCRIPT = readFileSync(
  resolve(AUTOCONSENT_DIST, "autoconsent.playwright.js"),
  "utf8",
);

interface AutoconsentRules {
  autoconsent?: unknown[];
  consentomatic?: Record<string, unknown>;
}

const RULES: AutoconsentRules = JSON.parse(
  readFileSync(
    require.resolve("@duckduckgo/autoconsent/rules/rules.json"),
    "utf8",
  ),
);

const CONFIG = {
  enabled: true,
  autoAction: "optOut" as const,
  disabledCmps: [] as string[],
  enablePrehide: true,
  enableCosmeticRules: true,
  enableGeneratedRules: true,
  detectRetries: 20,
  isMainWorld: false,
  prehideTimeout: 2000,
  enableFilterList: false,
  enableHeuristicDetection: true,
  enableHeuristicAction: true,
  logs: {
    lifecycle: false,
    rulesteps: false,
    detectionsteps: false,
    evals: false,
    errors: false,
    messages: false,
    waits: false,
  },
};

// Set BRAND_EXTRACT_DEBUG_AUTOCONSENT=1 to log CMP-detection events.
const DEBUG = process.env.BRAND_EXTRACT_DEBUG_AUTOCONSENT === "1";

interface PageState {
  resolveDone: () => void;
}

// Per-page state. WeakMap so closed pages get GC'd. We track the most
// recent `resolveDone` so each invocation of runAutoconsent gets a fresh
// race promise without leaking handlers.
const PAGE_STATE = new WeakMap<Page, PageState>();

/**
 * Inject autoconsent into a page that's already navigated. Sets up the
 * Node↔page message bridge on first call (per page) and replaces the
 * "done" resolver on every call. Races against `timeoutMs` so pages
 * with no CMP don't block.
 *
 * Caller must ensure: (1) page.goto has resolved (or its .catch
 * fallthrough has fired), (2) any meta extraction that depends on a
 * pristine fingerprint has already run.
 */
export async function runAutoconsent(
  page: Page,
  timeoutMs = 6000,
): Promise<void> {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  if (!PAGE_STATE.has(page)) {
    // First call on this page — set up the message bridge.
    try {
      await page.exposeFunction(
        "autoconsentSendMessage",
        async (message: { type: string; [k: string]: unknown }) => {
          if (!message || typeof message !== "object") return;

          switch (message.type) {
            case "init":
              await sendMessage(page, {
                type: "initResp",
                config: CONFIG,
                rules: RULES,
              });
              return;

            case "eval": {
              const code = message.code as string;
              const result = await page.evaluate(code).catch(() => null);
              await sendMessage(page, {
                type: "evalResp",
                id: message.id,
                result,
              });
              return;
            }

            case "autoconsentDone":
              if (DEBUG)
                console.warn("[autoconsent] done", message.cmp ?? "(no cmp)");
              PAGE_STATE.get(page)?.resolveDone();
              return;

            case "autoconsentError":
              if (DEBUG) console.warn("[autoconsent] error", message);
              PAGE_STATE.get(page)?.resolveDone();
              return;

            case "cmpDetected":
              if (DEBUG) console.warn("[autoconsent] cmpDetected", message.cmp);
              return;

            case "popupFound":
              if (DEBUG) console.warn("[autoconsent] popupFound", message.cmp);
              return;

            case "optOutResult":
              if (DEBUG)
                console.warn(
                  "[autoconsent] optOutResult",
                  message.cmp,
                  message.result,
                );
              return;
          }
        },
      );
    } catch {
      // exposeFunction can fail if context is already closed or if a
      // previous call somehow registered the same name. Either way, we
      // can't run autoconsent on this page — fall through silently.
      return;
    }
  }

  PAGE_STATE.set(page, { resolveDone });

  // Inject the autoconsent IIFE — it'll send 'init' immediately, our
  // handler responds with config + rules, and CMP detection begins.
  await page.evaluate(SCRIPT).catch(() => {
    /* page closed mid-injection; non-fatal */
  });

  await Promise.race([
    done,
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
}

function sendMessage(page: Page, message: unknown): Promise<void> {
  return page
    .evaluate((msg) => {
      const w = window as unknown as {
        autoconsentReceiveMessage?: (m: unknown) => void;
      };
      if (w.autoconsentReceiveMessage) w.autoconsentReceiveMessage(msg);
    }, message)
    .catch(() => {
      /* page navigated mid-message; non-fatal */
    });
}
