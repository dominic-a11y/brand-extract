/**
 * Shape of `dembrandt --json-only` output (verified against apple.com on
 * 2026-05-08 in adgen). Fields we don't currently consume are typed
 * `unknown` to keep the surface small. Tighten as you use them.
 */
export interface DembrandtLogo {
  source: "svg" | "img" | string;
  url: string;
  width: number;
  height: number;
  safeZone: { top: number; right: number; bottom: number; left: number };
  background: string;
}

export interface DembrandtFavicon {
  type: "og:image" | "favicon.ico" | string;
  url: string;
  sizes: string | null;
}

export interface DembrandtPaletteColor {
  /** Raw color string, e.g. "rgb(29, 29, 31)" */
  color: string;
  /** Hex form, e.g. "#1d1d1f" */
  normalized: string;
  count: number;
  confidence: "high" | "medium" | "low" | string;
  sources: string[];
  lch: string;
  oklch: string;
  pageCount: number;
}

export interface DembrandtTypeStyle {
  /** "heading-1" | "heading-2" | "body" | "button" | ... */
  context: string;
  family: string;
  fallbacks: string;
  size: string;
  weight: number;
  lineHeight: string;
  spacing: string;
  transform: string | null;
  count: number;
}

export interface DembrandtRaw {
  url: string;
  extractedAt: string;
  siteName: string;
  logo: DembrandtLogo | null;
  favicons: DembrandtFavicon[];
  colors: {
    semantic: Record<string, string>;
    palette: DembrandtPaletteColor[];
    cssVariables?: unknown;
    _raw?: unknown;
  };
  typography: {
    styles: DembrandtTypeStyle[];
    sources: {
      googleFonts: string[];
      adobeFonts: boolean;
      variableFonts: boolean;
    };
  };
  pages: Array<{ url: string; extractedAt: string }>;
  /** dembrandt returns more (spacing, borderRadius, components, etc.); kept open. */
  [key: string]: unknown;
}

/**
 * Lightweight page metadata grabbed via Playwright because dembrandt does
 * not return title / description / headings / product images.
 */
export interface PageMetadata {
  title: string | null;
  description: string | null;
  headings: string[];
  ogImage: string | null;
  productImages: string[];
}

export interface ExtractionResult {
  url: string;
  raw: DembrandtRaw | null;
  meta: PageMetadata;
  /** PNG buffer of the viewport (fold) screenshot — null if capture disabled
   *  or failed. Caller is responsible for storage. */
  screenshot: Buffer | null;
  /** Full rendered HTML — null unless `captureHtml` requested. */
  html: string | null;
  /** Scripts/styles/comments stripped, whitespace collapsed — null unless
   *  `captureSanitizedText` requested. */
  sanitizedText: string | null;
  /** Largest <img> in <header>, falling back to favicon — null unless
   *  `captureLogo` requested. `buffer` is null unless `fetchLogo` was also
   *  requested AND the fetch succeeded. */
  logo: { url: string; buffer: Buffer | null } | null;
  /** Subpage captures — empty unless `captureSubpages > 0`. Per-entry
   *  `screenshot` is null when that specific nav failed. */
  subpages: Array<{ url: string; screenshot: Buffer | null }>;
}

export interface ExtractOptions {
  /** dembrandt subprocess timeout. Default 60_000 ms. */
  dembrandtTimeoutMs?: number;
  /** Page navigation timeout. Default 20_000 ms. */
  pageLoadTimeoutMs?: number;
  /** Pages dembrandt should crawl. Default 3. */
  pages?: number;
  /** Viewport for the screenshot. Default 1280x800. */
  viewport?: { width: number; height: number };
  /** Skip the screenshot entirely. Default false. */
  skipScreenshot?: boolean;
  /** Reuse a Playwright Browser instance instead of launching one per call. */
  browser?: import("playwright").Browser;

  // ─── Thorough mode (all opt-in) ────────────────────────────────────────
  /** Include full rendered HTML in the result. */
  captureHtml?: boolean;
  /** Strip scripts/styles/comments + collapse whitespace from the HTML. */
  captureSanitizedText?: boolean;
  /** Find the largest <img> in <header>, fallback to favicon. */
  captureLogo?: boolean;
  /** Download the logo URL into a Buffer. Requires `captureLogo`. */
  fetchLogo?: boolean;
  /** Number of subpages to navigate + screenshot (max 5). Default 0. */
  captureSubpages?: number;
  /** RegExps to match subpage href targets. Default: about/product/pricing. */
  subpagePatterns?: RegExp[];
  /** Per-subpage nav timeout. Default 12_000 ms. */
  subpageNavTimeoutMs?: number;
}
