#!/usr/bin/env node
/**
 * MSG-EMOJI-NOTO-01: self-hosted Noto Color Emoji for chat (picker, bubbles,
 * composer), so emoji look the same crisp Noto style as the sticker pack on
 * every OS — including country flags, which Windows' Segoe UI Emoji lacks.
 *
 *   node apps/web/scripts/generate-emoji-font.mjs           # build
 *   node apps/web/scripts/generate-emoji-font.mjs --check   # verify only
 *
 * Source: googlefonts/noto-emoji release v2026-09-24-unicode18_0 (commit
 * e20cbc2), `2D/fonts/Noto-COLRv1.ttf`, SIL Open Font License 1.1. The vector
 * COLRv1 font is pinned by SHA-256 and subset with fontTools (Python, build
 * time only) into two lazily loaded WOFF2 files split by `unicode-range`:
 *
 *   apps/web/public/fonts/noto-emoji/v1/noto-emoji.woff2        everything but flags
 *   apps/web/public/fonts/noto-emoji/v1/noto-emoji-flags.woff2  regional-indicator flags
 *   apps/web/public/fonts/noto-emoji/v1/OFL.txt                 the font license
 *   apps/web/src/features/media/notoEmojiFont.css               @font-face rules
 *
 * ASCII, ©, ® and ™ (and so keycaps) stay out of the ranges so digits and
 * text symbols keep the text font. The `tech(color-COLRv1)` source hint makes
 * browsers without COLRv1 (Safari) fall back to the system emoji font.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const repoRoot = resolve(webRoot, "..", "..");
const FONT_VERSION = "v1";
const outputDir = join(webRoot, "public", "fonts", "noto-emoji", FONT_VERSION);
const cssPath = join(webRoot, "src", "features", "media", "notoEmojiFont.css");
const publicBase = `/fonts/noto-emoji/${FONT_VERSION}`;

export const FONT_FAMILY = "TutorHub Noto Emoji";
const COMMIT = "e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e";
const SOURCES = {
  font: {
    path: "2D/fonts/Noto-COLRv1.ttf",
    sha256: "b8e25ea68db82f9e4d0aee921f4420be2be39887bd5c893a2ad98710531f9d0c",
  },
  license: {
    path: "LICENSE",
    sha256: "500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b",
  },
};
const FILES = {
  flags: "noto-emoji-flags.woff2",
  main: "noto-emoji.woff2",
};
const LIMITS = { flags: 900 * 1024, main: 1600 * 1024 };

function fail(message) {
  console.error(`generate-emoji-font: ${message}`);
  process.exit(1);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function ensureSource(sourceDir, key, offline) {
  const source = SOURCES[key];
  const path = join(sourceDir, source.path.split("/").pop());
  if (!existsSync(path)) {
    if (offline) fail(`missing source ${path} (offline)`);
    const url = `https://raw.githubusercontent.com/googlefonts/noto-emoji/${COMMIT}/${source.path}`;
    const response = await fetch(url);
    if (!response.ok) fail(`download ${url} failed with HTTP ${response.status}`);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(`${path}.partial`, Buffer.from(await response.arrayBuffer()));
    renameSync(`${path}.partial`, path);
  }
  const digest = sha256(readFileSync(path));
  if (digest !== source.sha256) {
    fail(`SHA-256 mismatch for ${source.path}: got ${digest}, pinned ${source.sha256}`);
  }
  return path;
}

const SUBSETTER = String.raw`
import io, json, sys
from fontTools import subset
from fontTools.ttLib import TTFont

job = json.load(sys.stdin)
cmap = set(TTFont(job["font"]).getBestCmap())
excluded = set(range(0x00, 0x80)) | {0xA9, 0xAE, 0x2122, 0x20E3}
flags = set(range(0x1F1E6, 0x1F200))
groups = {
    # VS16 lives in the format-14 cmap; list it so "❤️" stays in this font.
    "main": sorted({c for c in cmap if c not in excluded and c not in flags} | {0xFE0F}),
    "flags": sorted(c for c in cmap if c in flags),
}
report = {}
for name, unicodes in groups.items():
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = False
    font = TTFont(job["font"])
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    buffer = io.BytesIO()
    font.flavor = "woff2"
    font.save(buffer)
    with open(job["outputs"][name], "wb") as handle:
        handle.write(buffer.getvalue())
    ranges = []
    for code in unicodes:
        if ranges and ranges[-1][1] == code - 1:
            ranges[-1][1] = code
        else:
            ranges.append([code, code])
    report[name] = {"bytes": len(buffer.getvalue()), "ranges": ranges}
json.dump(report, sys.stdout)
`;

function rangeText(ranges) {
  return ranges
    .map(([start, end]) =>
      start === end
        ? `U+${start.toString(16).toUpperCase()}`
        : `U+${start.toString(16).toUpperCase()}-${end.toString(16).toUpperCase()}`,
    )
    .join(", ");
}

function fontFace(file, ranges) {
  return `@font-face {
  font-family: "${FONT_FAMILY}";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("${publicBase}/${file}") format("woff2") tech(color-COLRv1);
  unicode-range: ${rangeText(ranges)};
}
`;
}

async function writeCss(report) {
  const text = `/*
 * GENERATED by apps/web/scripts/generate-emoji-font.mjs — do not edit.
 * Noto Color Emoji (COLRv1), SIL Open Font License 1.1 — see
 * ${publicBase}/OFL.txt and THIRD_PARTY_NOTICES.md.
 */
${fontFace(FILES.main, report.main.ranges)}
${fontFace(FILES.flags, report.flags.ranges)}`;
  let formatted = text;
  try {
    const prettier = await import("prettier");
    const options = (await prettier.resolveConfig(cssPath)) ?? {};
    formatted = await prettier.format(text, { ...options, filepath: cssPath });
  } catch {
    // Unformatted CSS is still valid.
  }
  writeFileSync(cssPath, formatted);
}

function check() {
  const problems = [];
  for (const [key, file] of Object.entries(FILES)) {
    const path = join(outputDir, file);
    if (!existsSync(path)) {
      problems.push(`missing ${relative(repoRoot, path)}`);
      continue;
    }
    const buffer = readFileSync(path);
    if (buffer.toString("ascii", 0, 4) !== "wOF2") {
      problems.push(`${file} is not a WOFF2 file`);
    }
    const size = statSync(path).size;
    if (size > LIMITS[key]) problems.push(`${file} is ${size} bytes (> ${LIMITS[key]})`);
  }
  const license = join(outputDir, "OFL.txt");
  if (!existsSync(license) || sha256(readFileSync(license)) !== SOURCES.license.sha256) {
    problems.push(`${relative(repoRoot, license)} must be the pinned Noto OFL text`);
  }
  const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
  for (const file of Object.values(FILES)) {
    if (!css.includes(`${publicBase}/${file}`)) {
      problems.push(`notoEmojiFont.css does not reference ${file}`);
    }
  }
  if (!css.includes("tech(color-COLRv1)") || !css.includes("unicode-range: U+1F1E6-1F1FF")) {
    problems.push("notoEmojiFont.css must declare COLRv1 sources and the flag range");
  }
  const notices = join(repoRoot, "THIRD_PARTY_NOTICES.md");
  if (!readFileSync(notices, "utf8").includes("Noto Color Emoji")) {
    problems.push("THIRD_PARTY_NOTICES.md must credit Noto Color Emoji (OFL 1.1)");
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  - ${problem}`);
    fail(`${problems.length} problem(s) in the emoji font`);
  }
  const sizes = Object.values(FILES).map((file) => statSync(join(outputDir, file)).size);
  console.log(
    `emoji font ok: ${sizes.reduce((sum, size) => sum + size, 0)} bytes (${Object.values(FILES).join(", ")})`,
  );
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--check")) {
    check();
    return;
  }
  const sourceDir = resolve(argument("--source-dir") ?? join(tmpdir(), "tutorhub-noto-color-emoji"));
  const offline = process.argv.includes("--offline");
  const fontPath = await ensureSource(sourceDir, "font", offline);
  const licensePath = await ensureSource(sourceDir, "license", offline);
  const staging = `${outputDir}.staging-${process.pid}`;
  rmSync(staging, { force: true, recursive: true });
  mkdirSync(staging, { recursive: true });
  const python =
    argument("--python") ?? process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, ["-I", "-c", SUBSETTER], {
    cwd: tmpdir(),
    encoding: "utf8",
    input: JSON.stringify({
      font: fontPath,
      outputs: { flags: join(staging, FILES.flags), main: join(staging, FILES.main) },
    }),
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.error || result.status !== 0) {
    rmSync(staging, { force: true, recursive: true });
    fail(`fontTools subsetting failed (Python 3 with fonttools and brotli is required)`);
  }
  const report = JSON.parse(result.stdout);
  writeFileSync(join(staging, "OFL.txt"), readFileSync(licensePath));
  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(dirname(outputDir), { recursive: true });
  renameSync(staging, outputDir);
  await writeCss(report);
  console.log(`subset: main ${report.main.bytes} bytes, flags ${report.flags.bytes} bytes`);
  check();
}

await main();
