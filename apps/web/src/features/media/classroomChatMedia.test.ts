// @vitest-environment jsdom

import type { Sticker } from "@tutorhub/api-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_STICKER_RECENT_LIMIT,
  chatMentionNames,
  chatStickerRecentKey,
  isChatStickerID,
  linkifyChatText,
  loadChatStickerRecents,
  recordChatStickerRecent,
  searchChatStickers,
  splitChatMentions,
} from "./classroomChatMedia";

// MSG-MENTION-BLUE-01 and MSG-STICKER-03 helpers.

describe("chat mentions", () => {
  const names = chatMentionNames([
    "Nguyễn Văn An",
    "Nguyễn Văn",
    " Trần Minh Anh ",
    "",
    null,
    "Nguyễn Văn An",
  ]);

  it("keeps distinct names, longest first", () => {
    expect(names).toEqual(["Nguyễn Văn An", "Trần Minh Anh", "Nguyễn Văn"]);
  });

  it("matches whole member names after @ and leaves the rest as text", () => {
    expect(
      splitChatMentions("@Nguyễn Văn An làm xong bài chưa?", names),
    ).toEqual([
      { kind: "mention", text: "@Nguyễn Văn An" },
      { kind: "text", text: " làm xong bài chưa?" },
    ]);
    expect(
      splitChatMentions("Hỏi @Nguyễn Văn, rồi @Trần Minh Anh.", names),
    ).toEqual([
      { kind: "text", text: "Hỏi " },
      { kind: "mention", text: "@Nguyễn Văn" },
      { kind: "text", text: ", rồi " },
      { kind: "mention", text: "@Trần Minh Anh" },
      { kind: "text", text: "." },
    ]);
  });

  it("ignores emails, unknown names and name prefixes", () => {
    for (const text of [
      "gửi an@example.com nhé",
      "@Lê Thu Hà ơi",
      "@Trần Minh Anhh",
      "@@",
    ]) {
      expect(
        splitChatMentions(text, names).every((piece) => piece.kind === "text"),
      ).toBe(true);
    }
    expect(splitChatMentions("", names)).toEqual([]);
    expect(splitChatMentions("@Nguyễn Văn An", [])).toEqual([
      { kind: "text", text: "@Nguyễn Văn An" },
    ]);
  });

  it("finds mentions only outside links", () => {
    expect(
      linkifyChatText(
        "@Trần Minh Anh xem https://example.com/@Trần Minh Anh",
        names,
      ),
    ).toEqual([
      { kind: "mention", text: "@Trần Minh Anh" },
      { kind: "text", text: " xem " },
      {
        kind: "link",
        href: "https://example.com/@Tr%E1%BA%A7n",
        text: "https://example.com/@Trần",
      },
      { kind: "text", text: " Minh Anh" },
    ]);
    expect(linkifyChatText("no names here")).toEqual([
      { kind: "text", text: "no names here" },
    ]);
  });
});

function sticker(
  code: string,
  vi: string,
  en: string,
  keywords: string[],
): Sticker {
  return {
    id: `noto_animated:${code}`,
    labels: { vi, en },
    keywords: { vi: keywords, en: [] },
    animated: true,
    asset: {
      animated_url: `/stickers/noto_animated/v1/${code}.webp`,
      static_url: `/stickers/noto_animated/v1/${code}.static.webp`,
      width: 160,
      height: 160,
    },
  };
}

describe("sticker helpers", () => {
  afterEach(() => localStorage.clear());

  const stickers = [
    sticker("1f44f", "Vỗ tay", "Clapping", ["hoan hô", "giỏi lắm"]),
    sticker("1f600", "Cười tươi", "Smile", ["vui"]),
    sticker("1f602", "Cười ra nước mắt", "Tears of joy", ["buồn cười"]),
    sticker("1f913", "Mọt sách", "Nerd", ["học bá", "chăm học"]),
  ];

  it("searches labels and keywords in vi and en without accents", () => {
    const labels = (query: string) =>
      searchChatStickers(stickers, query).map((item) => item.labels.vi);
    expect(labels("cuoi")).toEqual(["Cười tươi", "Cười ra nước mắt"]);
    expect(labels("CƯỜI TƯƠI")).toEqual(["Cười tươi"]);
    expect(labels("hoc")).toEqual(["Mọt sách"]);
    expect(labels("tears")).toEqual(["Cười ra nước mắt"]);
    expect(labels("gioi lam")).toEqual(["Vỗ tay"]);
    expect(labels("   ")).toEqual([]);
    expect(labels("khủng long")).toEqual([]);
  });

  it("validates sticker IDs like the server", () => {
    expect(isChatStickerID("noto_animated:1f602")).toBe(true);
    for (const value of ["", "noto", "NOTO:1f602", "noto:../x", 42, null]) {
      expect(isChatStickerID(value)).toBe(false);
    }
  });

  it("keeps at most 24 recent sticker IDs per tenant and user", () => {
    const scope = { actorID: "user-a", tenantID: "tenant-a" };
    expect(chatStickerRecentKey(scope)).toBe(
      "tutorhub:chat-sticker-recent:v1:tenant-a:user-a",
    );
    let recents: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      recents = recordChatStickerRecent(
        scope,
        recents,
        `noto_animated:${index}`,
      );
    }
    recents = recordChatStickerRecent(scope, recents, "noto_animated:10");
    expect(recents).toHaveLength(CHAT_STICKER_RECENT_LIMIT);
    expect(recents[0]).toBe("noto_animated:10");
    expect(loadChatStickerRecents(scope)).toEqual(recents);
    expect(
      loadChatStickerRecents({ actorID: "user-b", tenantID: "tenant-a" }),
    ).toEqual([]);
    expect(recordChatStickerRecent(scope, recents, "<script>")).toEqual(
      recents,
    );

    localStorage.setItem(
      chatStickerRecentKey(scope),
      JSON.stringify([
        "noto_animated:1f602",
        "bad id",
        7,
        "noto_animated:1f602",
      ]),
    );
    expect(loadChatStickerRecents(scope)).toEqual(["noto_animated:1f602"]);
    localStorage.setItem(chatStickerRecentKey(scope), "{not json");
    expect(loadChatStickerRecents(scope)).toEqual([]);
  });
});
