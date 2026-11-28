# Third-party notices

This file lists third-party material that TutorHub distributes as content
(not code dependencies, whose licenses ship with each package). The web app
serves the same notice at `/THIRD_PARTY_NOTICES.txt`
(`apps/web/public/THIRD_PARTY_NOTICES.txt`).

## Noto Emoji Animation (stickers)

- **Material:** animated emoji artwork from the Noto Emoji Animation project.
- **Creator:** Google LLC — <https://googlefonts.github.io/noto-emoji-animation/>
- **Source files:** `https://fonts.gstatic.com/s/e/notoemoji/latest/<codepoint>/512.webp`,
  each pinned by SHA-256 in `apps/web/scripts/generate-sticker-catalog.mjs`
  (retrieved 2026-11-28).
- **License:** Creative Commons Attribution 4.0 International (CC BY 4.0) —
  <https://creativecommons.org/licenses/by/4.0/>
  (legal code: <https://creativecommons.org/licenses/by/4.0/legalcode>).
- **Used in:** `apps/web/public/stickers/noto_animated/v1/` (the "Noto
  Animated" sticker pack in Messages and classroom room chat).

### Modifications (CC BY 4.0, Section 3(a)(1)(B))

TutorHub modified the material on 2026-11-28:

1. Selected a curated subset of 103 emoji (faces, encouragement gestures,
   hearts, celebration and study symbols).
2. Resized every frame from 512×512 to 160×160 pixels.
3. Reduced the frame count (keeping every 1st to 6th frame and merging frame
   durations) and re-encoded each animation as a lossy animated WebP of at
   most 100 KB.
4. Extracted one representative frame of each animation (the frame that
   differs most from the first) as a separate static WebP
   (`<codepoint>.static.webp`) for reduced motion and idle previews.
5. Renamed the files to `<codepoint>.webp` / `<codepoint>.static.webp`.

### Disclaimer

The material is provided as-is under CC BY 4.0. To the extent possible, the
licensor offers it without warranties of any kind (see Section 5 of the
license). Google does not endorse TutorHub or its use of the material.

## Noto Color Emoji (emoji font)

- **Material:** the Noto Color Emoji font (vector COLRv1 build), used to draw
  emoji in the chat emoji picker, message bubbles and composers.
- **Copyright:** Copyright 2013 Google LLC — <https://github.com/googlefonts/noto-emoji>
- **Source:** release `v2026-09-24-unicode18_0` (commit `e20cbc2`),
  `2D/fonts/Noto-COLRv1.ttf`, pinned by SHA-256 in
  `apps/web/scripts/generate-emoji-font.mjs`.
- **License:** SIL Open Font License, Version 1.1 —
  <https://openfontlicense.org>; the full text ships next to the font at
  `apps/web/public/fonts/noto-emoji/v1/OFL.txt` (served at
  `/fonts/noto-emoji/v1/OFL.txt`).
- **Modifications:** subset with fontTools into two WOFF2 files (all emoji
  except flags; regional-indicator flags) with the original name and license
  metadata kept. The font is not sold on its own.
