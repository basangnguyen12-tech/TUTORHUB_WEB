import type { ClassroomCodeWorkspaceFile } from "../codeSession";

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §3 HTML / CSS / JS preview. The page renders
 * only after the user presses Run, inside `<iframe sandbox="allow-scripts">`
 * (opaque origin, no forms, popups, modals, downloads or top navigation).
 * Our own `<head>` with this CSP comes first, before any user markup, so the
 * policy applies to every script on the page: no fetch / XHR / WebSocket,
 * no remote scripts, styles, images, fonts or frames.
 */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';";

/** Local files referenced as `href="style.css"` / `src="script.js"`. */
function localFile(
  files: readonly ClassroomCodeWorkspaceFile[],
  reference: string,
): ClassroomCodeWorkspaceFile | undefined {
  const name = reference.trim().replace(/^\.\//, "");
  return files.find((file) => file.name === name);
}

function escapeClosingTag(content: string, tag: "script" | "style"): string {
  return content.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");
}

/**
 * Inlines workspace stylesheets and scripts referenced by relative name, so
 * a multi-file project (index.html + style.css + script.js) previews without
 * any network request.
 */
export function inlineWorkspaceAssets(
  html: string,
  files: readonly ClassroomCodeWorkspaceFile[],
): string {
  const withStyles = html.replace(
    /<link\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>/gi,
    (tag, _quote: string, href: string) => {
      if (!/\brel\s*=\s*(["'])stylesheet\1/i.test(tag)) return tag;
      const file = localFile(files, href);
      if (!file || file.language !== "css") return tag;
      return `<style data-file="${file.name}">${escapeClosingTag(file.content, "style")}</style>`;
    },
  );
  return withStyles.replace(
    /<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi,
    (tag, before: string, _quote: string, src: string, after: string) => {
      const file = localFile(files, src);
      if (!file || file.language !== "javascript") return tag;
      const attributes = `${before}${after}`.replace(/\s+/g, " ").trim();
      return `<script${attributes ? ` ${attributes}` : ""}>${escapeClosingTag(file.content, "script")}</script>`;
    },
  );
}

/** The preview entry: the active HTML file, else the first HTML file. */
export function previewEntry(
  files: readonly ClassroomCodeWorkspaceFile[],
  activeIndex: number,
): ClassroomCodeWorkspaceFile | null {
  const active = files[activeIndex];
  if (active?.language === "html") return active;
  return files.find((file) => file.language === "html") ?? null;
}

export function buildPreviewDocument(
  files: readonly ClassroomCodeWorkspaceFile[],
  activeIndex: number,
): string | null {
  const entry = previewEntry(files, activeIndex);
  if (!entry) return null;
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "</head>",
    inlineWorkspaceAssets(entry.content, files),
    "</html>",
  ].join("\n");
}
