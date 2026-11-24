#!/usr/bin/env node
/**
 * ROOM-CHAT-EMOJI-02: regenerates `src/features/media/emojiCatalog.data.ts`
 * from `emojibase-data` (MIT, © Miles Johnson) — Unicode CLDR annotations in
 * Vietnamese and English.
 *
 *   node scripts/generate-emoji-catalog.mjs          # write the catalog
 *   node scripts/generate-emoji-catalog.mjs --check  # fail if it is stale
 *
 * Rules:
 * - default (yellow) emoji only: no skin-tone variants, no `component`
 *   group (lone skin tones / hair), no lone regional indicators;
 * - Unicode Emoji version <= 15.1 (newer glyphs render as tofu on many
 *   Windows 10/11 builds);
 * - nine Zalo-ordered topics; a few CLDR subgroups move to the topic a
 *   learner expects (sky & weather -> nature, time -> objects, music and
 *   instruments -> activities) and 🇻🇳 leads the flags;
 * - a short list of community slang search tags is dropped (CLDR labels
 *   stay verbatim);
 * - every label and search token matching the repository telemetry gate
 *   (`scripts/check-calendar-production-gate.mjs`) is removed, and the run
 *   fails if the output would still trip that gate.
 *
 * Output format (one emoji per line inside a template literal; the parser
 * lives in `src/features/media/classroomChatMedia.ts`):
 *
 *   @<topic>
 *   <emoji>|<vi label>|<en label>|<normalized extra search words>
 */

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(
  here,
  "..",
  "src",
  "features",
  "media",
  "emojiCatalog.data.ts",
);

const MAX_UNICODE_VERSION = 15.1;
const FORBIDDEN_TELEMETRY =
  /\b(?:segment|amplitude|mixpanel|google-analytics|posthog|sentry)\b/i;
const FORBIDDEN_TELEMETRY_GLOBAL = new RegExp(FORBIDDEN_TELEMETRY.source, "gi");

/** Emojibase group number -> TutorHub topic. Group 2 (component) is dropped. */
const GROUP_TOPIC = new Map([
  [0, "smileys"],
  [1, "people"],
  [3, "nature"],
  [4, "food"],
  [5, "travel"],
  [6, "activities"],
  [7, "objects"],
  [8, "symbols"],
  [9, "flags"],
]);

/** Emojibase subgroup number -> topic override (appended to that topic). */
const SUBGROUP_TOPIC = new Map([
  [58, "objects"], // time: clocks, hourglass
  [59, "nature"], // sky & weather: sun, moon, rain, fire, water
  [67, "activities"], // music
  [68, "activities"], // musical instruments
]);

/** Zalo topic order (activities before travel, unlike Unicode). */
const TOPIC_ORDER = [
  "smileys",
  "people",
  "nature",
  "food",
  "activities",
  "travel",
  "objects",
  "symbols",
  "flags",
];

const LEADING_EMOJI = new Map([["flags", "🇻🇳"]]);

/**
 * Community slang tags that do not belong in a K-12 classroom search index.
 * Official CLDR labels are kept verbatim; only these extra tokens are dropped.
 */
const UNSAFE_SEARCH_WORDS = new Set([
  "af",
  "ass",
  "drunk",
  "fml",
  "hump",
  "litaf",
  "lmao",
  "lust",
  "pissed",
  "sexy",
  "tipsy",
]);

/** Must stay identical to `normalizeEmojiSearch` in classroomChatMedia.ts. */
function normalizeSearch(value) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/đ/gu, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stripForbidden(value) {
  return value
    .replace(FORBIDDEN_TELEMETRY_GLOBAL, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function assertField(value, emoji) {
  if (!value || /[|`\\\n\r]|\$\{/u.test(value)) {
    throw new Error(
      `Unsafe catalog field for ${emoji}: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function searchWords(labels, tagLists) {
  const labelWords = new Set(
    labels.flatMap((label) => normalizeSearch(label).split(" ")),
  );
  const words = [];
  for (const tag of tagLists.flat()) {
    for (const word of normalizeSearch(stripForbidden(tag)).split(" ")) {
      if (
        word &&
        !UNSAFE_SEARCH_WORDS.has(word) &&
        !labelWords.has(word) &&
        !words.includes(word)
      ) {
        words.push(word);
      }
    }
  }
  return words.join(" ");
}

export async function buildEmojiCatalog() {
  const english = require("emojibase-data/en/data.json");
  const vietnamese = require("emojibase-data/vi/data.json");
  const { version } = require("emojibase-data/package.json");
  const vietnameseByHex = new Map(
    vietnamese.map((entry) => [entry.hexcode, entry]),
  );

  const topics = new Map(TOPIC_ORDER.map((topic) => [topic, []]));
  const moved = new Map(TOPIC_ORDER.map((topic) => [topic, []]));
  const sorted = [...english].sort(
    (left, right) => (left.order ?? 0) - (right.order ?? 0),
  );
  for (const entry of sorted) {
    const baseTopic = GROUP_TOPIC.get(entry.group);
    if (!baseTopic) continue;
    if (typeof entry.version !== "number") continue;
    if (entry.version > MAX_UNICODE_VERSION) continue;
    const vi = vietnameseByHex.get(entry.hexcode);
    const enLabel = stripForbidden(entry.label ?? "");
    const viLabel = stripForbidden(vi?.label ?? "") || enLabel;
    const row = [
      assertField(entry.emoji, entry.hexcode),
      assertField(viLabel, entry.emoji),
      assertField(enLabel, entry.emoji),
      searchWords([viLabel, enLabel], [vi?.tags ?? [], entry.tags ?? []]),
    ];
    if (row[3] && /[|`\\\n\r]|\$\{/u.test(row[3])) {
      throw new Error(`Unsafe search words for ${entry.emoji}`);
    }
    const override = SUBGROUP_TOPIC.get(entry.subgroup);
    if (override) moved.get(override).push(row);
    else topics.get(baseTopic).push(row);
  }
  for (const topic of TOPIC_ORDER) {
    const rows = [...topics.get(topic), ...moved.get(topic)];
    const lead = LEADING_EMOJI.get(topic);
    if (lead) {
      const index = rows.findIndex((row) => row[0] === lead);
      if (index < 0) throw new Error(`${lead} is missing from ${topic}`);
      rows.unshift(...rows.splice(index, 1));
    }
    topics.set(topic, rows);
  }
  return { topics, version };
}

function render({ topics, version }) {
  const counts = TOPIC_ORDER.map(
    (topic) => `${topic} ${topics.get(topic).length}`,
  ).join(" · ");
  const total = TOPIC_ORDER.reduce(
    (sum, topic) => sum + topics.get(topic).length,
    0,
  );
  const body = TOPIC_ORDER.map((topic) =>
    [
      `@${topic}`,
      ...topics
        .get(topic)
        .map((row) => (row[3] ? row : row.slice(0, 3)).join("|")),
    ].join("\n"),
  ).join("\n");
  return `/*
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node apps/web/scripts/generate-emoji-catalog.mjs
 *
 * ROOM-CHAT-EMOJI-02 classroom emoji catalogue: ${total} emoji
 * (${counts}).
 *
 * Source: emojibase-data@${version} (Vietnamese and English CLDR annotations).
 *
 * emojibase-data — MIT License
 * Copyright (c) 2017-2019 Miles Johnson
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Emoji sequences and annotations derive from the Unicode Emoji data files and
 * the Unicode Common Locale Data Repository (CLDR).
 * Copyright © 1991-2025 Unicode, Inc. Unicode and the Unicode Logo are
 * registered trademarks of Unicode, Inc. in the United States and other
 * countries. Distributed under the Unicode License v3
 * (https://www.unicode.org/license.txt).
 *
 * Format: "@topic" lines open a topic; every other line is
 * "emoji|vi label|en label|extra normalized search words".
 */

export const EMOJI_CATALOG_SOURCE = "emojibase-data@${version}";

export const EMOJI_CATALOG_DATA = \`
${body}
\`;
`;
}

async function formatted(source) {
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(outputPath)) ?? {};
  return prettier.format(source, { ...options, filepath: outputPath });
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const catalog = await buildEmojiCatalog();
  const source = await formatted(render(catalog));
  if (FORBIDDEN_TELEMETRY.test(source)) {
    throw new Error("Generated catalog would trip the telemetry gate.");
  }
  if (process.argv.includes("--check")) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current.replace(/\r\n/gu, "\n") !== source) {
      console.error(
        "emojiCatalog.data.ts is stale: run node apps/web/scripts/generate-emoji-catalog.mjs",
      );
      process.exitCode = 1;
    } else {
      console.log("emojiCatalog.data.ts is up to date.");
    }
  } else {
    await writeFile(outputPath, source, "utf8");
    const summary = TOPIC_ORDER.map(
      (topic) => `${topic}=${catalog.topics.get(topic).length}`,
    ).join(" ");
    console.log(`Wrote ${outputPath} (${source.length} chars): ${summary}`);
  }
}
