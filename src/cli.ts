#!/usr/bin/env node
import fs from "node:fs/promises";
import { extractBrand, closeBrowser } from "./index.js";

const HELP = `brand-extract — URL → brand tokens + meta + screenshot.

Usage:
  brand-extract <url> [options]

Options:
  --json                Print full result as JSON (buffers base64-encoded)
  --screenshot <path>   Write the viewport screenshot to <path>
  --thorough            Enable captureHtml + captureSanitizedText + captureLogo
                        + fetchLogo + captureSubpages=3
  --help, -h            Show this help

Examples:
  brand-extract https://stripe.com
  brand-extract https://gymshark.com --screenshot ./gymshark.png
  brand-extract https://supreme.com/shop --thorough --json > result.json
`;

function arg(name: string, argv: string[]): string | null {
  const i = argv.indexOf(name);
  if (i < 0 || i === argv.length - 1) return null;
  return argv[i + 1] ?? null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const url = argv[0]!;
  if (url.startsWith("--")) {
    console.error("brand-extract: first arg must be a URL");
    process.stdout.write(HELP);
    process.exit(2);
  }

  const wantJson = argv.includes("--json");
  const thorough = argv.includes("--thorough");
  const screenshotPath = arg("--screenshot", argv);

  const result = await extractBrand(
    url,
    thorough
      ? {
          captureHtml: true,
          captureSanitizedText: true,
          captureLogo: true,
          fetchLogo: true,
          captureSubpages: 3,
        }
      : {},
  );

  if (screenshotPath && result.screenshot) {
    await fs.writeFile(screenshotPath, result.screenshot);
  }

  if (wantJson) {
    const serializable = {
      ...result,
      screenshot: result.screenshot
        ? result.screenshot.toString("base64")
        : null,
      logo: result.logo
        ? {
            url: result.logo.url,
            buffer: result.logo.buffer
              ? result.logo.buffer.toString("base64")
              : null,
          }
        : null,
      subpages: result.subpages.map((s) => ({
        url: s.url,
        screenshot: s.screenshot ? s.screenshot.toString("base64") : null,
      })),
    };
    console.log(JSON.stringify(serializable, null, 2));
    return;
  }

  // Pretty summary
  const line = "─".repeat(60);
  const safeSlice = (s: string | null, n: number): string =>
    s ? (s.length > n ? `${s.slice(0, n)}…` : s) : "(none)";

  console.log(line);
  console.log("brand-extract", url);
  console.log(line);
  console.log("title         ", safeSlice(result.meta.title, 80));
  console.log("description   ", safeSlice(result.meta.description, 80));
  console.log(
    "headings      ",
    result.meta.headings.slice(0, 3).join(" | ") || "(none)",
  );
  console.log("og:image      ", result.meta.ogImage ?? "(none)");
  console.log("product images", result.meta.productImages.length);
  console.log("dembrandt     ", result.raw ? "ok" : "FAILED");
  if (result.raw?.siteName) {
    console.log("  siteName    ", result.raw.siteName);
  }
  if (result.raw?.colors?.palette?.length) {
    const top = result.raw.colors.palette
      .slice(0, 5)
      .map((c) => c.normalized)
      .join(", ");
    console.log("  palette     ", top);
  }
  if (result.raw?.typography?.styles?.length) {
    const fams = Array.from(
      new Set(result.raw.typography.styles.map((s) => s.family)),
    ).slice(0, 3);
    console.log("  fonts       ", fams.join(", "));
  }
  console.log(
    "screenshot    ",
    result.screenshot ? `${result.screenshot.length} bytes` : "(none)",
  );
  if (screenshotPath && result.screenshot) {
    console.log("              → wrote", screenshotPath);
  }
  if (result.html !== null) {
    console.log("html          ", `${result.html.length} chars`);
  }
  if (result.sanitizedText !== null) {
    console.log("sanitizedText ", `${result.sanitizedText.length} chars`);
  }
  if (result.logo) {
    console.log("logo url      ", result.logo.url);
    if (result.logo.buffer) {
      console.log("logo buffer   ", `${result.logo.buffer.length} bytes`);
    }
  }
  if (result.subpages.length > 0) {
    console.log("subpages");
    for (const s of result.subpages) {
      console.log(
        `  ${s.url}`,
        "→",
        s.screenshot ? `${s.screenshot.length}b` : "FAILED",
      );
    }
  }
  console.log(line);
}

main()
  .catch((err) => {
    console.error(
      "brand-extract error:",
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 2;
  })
  .finally(async () => {
    await closeBrowser();
  });
