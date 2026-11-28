// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Sticker,
  StickerEmbed,
  StickerPackCatalog,
  TenantCapabilities,
} from "@tutorhub/api-client";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import { tenantCapabilityQueryKeys } from "../../app/tenantCapabilities";
import { availableTenantCapabilities } from "../../test/tenantCapabilities";
import { ChatExpressionPicker, ChatStickerView } from "./ChatExpressionPicker";
import { chatStickerRecentKey } from "./classroomChatMedia";

// MSG-STICKER-03 (ADR-0047): Sticker | Emoji picker and in-thread stickers.
const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const actorID = "be85eb92-0f18-4163-85ba-50e4d343d632";
const scope = { actorID, tenantID };

function sticker(
  code: string,
  vi: string,
  en: string,
  keywords: string[] = [],
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

const stickers = [
  sticker("1f600", "Cười tươi", "Smile", ["vui"]),
  sticker("1f602", "Cười ra nước mắt", "Tears of joy", ["buồn cười"]),
  sticker("1f44f", "Vỗ tay", "Clapping", ["hoan hô"]),
  sticker("1f44d", "Thích", "Thumbs up"),
  sticker("1f525", "Lửa", "Fire"),
  sticker("1f393", "Mũ tốt nghiệp", "Graduation cap", ["học"]),
];

const catalog: StickerPackCatalog = {
  catalog_version: "2026-11-28.1",
  packs: [
    {
      id: "noto_animated",
      version: "v1",
      title: { vi: "Biểu cảm Noto", en: "Noto Animated" },
      attribution: {
        text: "Noto Emoji Animation by Google, licensed under CC BY 4.0.",
        license: "CC BY 4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
        notices_path: "/THIRD_PARTY_NOTICES.txt",
      },
      stickers,
    },
  ],
};

function capabilities(enabled: boolean): TenantCapabilities {
  const value = availableTenantCapabilities(tenantID);
  return {
    ...value,
    features: {
      ...value.features,
      chat_stickers: { configured_enabled: enabled, enabled },
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type":
        status >= 400 ? "application/problem+json" : "application/json",
    },
  });
}

function Harness({
  onSendSticker,
  readOnly = false,
}: {
  onSendSticker: (sticker: Sticker) => void;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLDivElement>(null);
  return (
    <div ref={card}>
      <textarea
        aria-label="Soạn tin"
        defaultValue="Bài 3 đáp án là"
        ref={composer}
      />
      <ChatExpressionPicker
        boundaryRef={card}
        composerRef={composer}
        onOpenChange={setOpen}
        onSelectEmoji={vi.fn()}
        onSendSticker={onSendSticker}
        open={open}
        readOnly={readOnly}
        recentScope={scope}
        tenantID={tenantID}
      />
    </div>
  );
}

function renderPicker(
  options: {
    enabled?: boolean;
    readOnly?: boolean;
    responses?: (() => Response)[];
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    tenantCapabilityQueryKeys.detail(tenantID),
    capabilities(options.enabled ?? true),
  );
  const responses = [...(options.responses ?? [() => jsonResponse(catalog)])];
  const fetchMock = vi.fn(async (request: Request) => {
    if (
      new URL(request.url).pathname.endsWith("/conversations/sticker-packs")
    ) {
      const next = responses.length > 1 ? responses.shift() : responses[0];
      return next ? next() : jsonResponse(catalog);
    }
    return jsonResponse({ code: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onSendSticker = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="vi">
        <Harness onSendSticker={onSendSticker} readOnly={options.readOnly} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { fetchMock, onSendSticker, view };
}

function stickerRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([request]) =>
    (request as Request).url.endsWith("/sticker-packs"),
  );
}

async function openStickerTab() {
  fireEvent.click(screen.getByRole("button", { name: "Biểu tượng cảm xúc" }));
  const tab = await screen.findByRole("tab", { name: "Sticker" });
  fireEvent.click(tab);
  return tab;
}

describe("ChatExpressionPicker", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("stays the Emoji-only picker when chat_stickers is off", async () => {
    const { fetchMock } = renderPicker({ enabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Biểu tượng cảm xúc" }));
    expect(
      await screen.findByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Sticker" })).toBeNull();
    expect(stickerRequests(fetchMock)).toHaveLength(0);
  });

  it("lists, searches accent-free and sends a sticker without touching the draft", async () => {
    const { onSendSticker } = renderPicker();
    const tab = await openStickerTab();
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(sessionStorage.getItem("tutorhub:chat-expression-tab:v1")).toBe(
      "sticker",
    );
    const panel = screen.getByRole("tabpanel", { name: "Sticker" });
    expect(
      await within(panel).findByRole("button", { name: "Vỗ tay" }),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/CC BY 4\.0/)).toBeInTheDocument();
    const credits = within(panel).getByRole("link", { name: /Ghi nguồn bộ/ });
    expect(credits).toHaveAttribute("href", "/THIRD_PARTY_NOTICES.txt");
    expect(credits).toHaveAttribute("target", "_blank");

    const search = within(panel).getByRole("searchbox", {
      name: "Tìm sticker",
    });
    fireEvent.change(search, { target: { value: "cuoi" } });
    const results = within(panel).getByRole("group", { name: "2 sticker" });
    expect(
      within(results)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Cười tươi", "Cười ra nước mắt"]);
    fireEvent.change(search, { target: { value: "hoan ho" } });
    expect(
      within(panel).getByRole("button", { name: "Vỗ tay" }),
    ).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "khủng long" } });
    expect(
      within(panel).getByText("Không tìm thấy sticker phù hợp.", {
        selector: ".chat-sticker__empty",
      }),
    ).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });

    fireEvent.click(within(panel).getByRole("button", { name: "Vỗ tay" }));
    expect(onSendSticker).toHaveBeenCalledWith(stickers[2]);
    expect(screen.queryByRole("dialog")).toBeNull();
    const composer = screen.getByRole("textbox", { name: "Soạn tin" });
    expect(composer).toHaveFocus();
    expect(composer).toHaveValue("Bài 3 đáp án là");
    expect(
      JSON.parse(localStorage.getItem(chatStickerRecentKey(scope)) ?? "[]"),
    ).toEqual(["noto_animated:1f44f"]);

    // The Sticker tab and the Recent row come back next time.
    fireEvent.click(screen.getByRole("button", { name: "Biểu tượng cảm xúc" }));
    const again = await screen.findByRole("tabpanel", { name: "Sticker" });
    const recent = within(again).getByRole("group", { name: "Gần đây" });
    expect(
      within(recent).getByRole("button", { name: "Vỗ tay" }),
    ).toBeInTheDocument();
  });

  it("moves through the 4-column grid and animates only hovered or focused tiles", async () => {
    renderPicker();
    await openStickerTab();
    const panel = screen.getByRole("tabpanel", { name: "Sticker" });
    const first = await within(panel).findByRole("button", {
      name: "Cười tươi",
    });
    const image = () =>
      within(panel)
        .getByRole("button", { name: "Cười tươi" })
        .querySelector("img");
    expect(image()).toHaveAttribute(
      "src",
      "/stickers/noto_animated/v1/1f600.static.webp",
    );
    expect(image()).toHaveAttribute("loading", "lazy");

    fireEvent.pointerEnter(first);
    expect(image()).toHaveAttribute(
      "src",
      "/stickers/noto_animated/v1/1f600.webp",
    );
    fireEvent.pointerLeave(first);
    expect(image()).toHaveAttribute(
      "src",
      "/stickers/noto_animated/v1/1f600.static.webp",
    );

    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(
      within(panel).getByRole("button", { name: "Cười ra nước mắt" }),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(
      within(panel).getByRole("button", { name: "Mũ tốt nghiệp" }),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(
      within(panel).getByRole("button", { name: "Cười ra nước mắt" }),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(
      within(panel).getByRole("searchbox", { name: "Tìm sticker" }),
    ).toHaveFocus();
  });

  it("never plays animations in the grid under reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        addEventListener: vi.fn(),
        matches: query.includes("reduce"),
        media: query,
        removeEventListener: vi.fn(),
      })),
    );
    renderPicker();
    await openStickerTab();
    const panel = screen.getByRole("tabpanel", { name: "Sticker" });
    const tile = await within(panel).findByRole("button", { name: "Lửa" });
    fireEvent.pointerEnter(tile);
    expect(tile.querySelector("img")).toHaveAttribute(
      "src",
      "/stickers/noto_animated/v1/1f525.static.webp",
    );
  });

  it("switches tabs with the arrow keys and closes on Escape back to the trigger", async () => {
    renderPicker();
    const tab = await openStickerTab();
    act(() => tab.focus());
    fireEvent.keyDown(tab, { key: "ArrowRight" });
    const emoji = screen.getByRole("tab", { name: "Emoji" });
    expect(emoji).toHaveAttribute("aria-selected", "true");
    expect(emoji).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Emoji" })).toBeInTheDocument();
    fireEvent.keyDown(emoji, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Sticker" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Sticker" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Biểu tượng cảm xúc" }),
    ).toHaveFocus();
  });

  it("shows loading, then error with retry, and recovers", async () => {
    const { fetchMock } = renderPicker({
      responses: [
        () =>
          jsonResponse({ code: "conversation_unavailable", status: 400 }, 400),
        () => jsonResponse(catalog),
      ],
    });
    await openStickerTab();
    const panel = screen.getByRole("tabpanel", { name: "Sticker" });
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("Chưa tải được bộ sticker.");
    fireEvent.click(within(alert).getByRole("button", { name: "Thử lại" }));
    expect(
      await within(panel).findByRole("button", { name: "Vỗ tay" }),
    ).toBeInTheDocument();
    expect(stickerRequests(fetchMock)).toHaveLength(2);
  });

  it("falls back to the Emoji picker when the server answers feature_disabled", async () => {
    renderPicker({
      responses: [
        () =>
          jsonResponse(
            {
              code: "feature_disabled",
              status: 403,
              title: "Feature disabled",
            },
            403,
          ),
      ],
    });
    await openStickerTab();
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Sticker" })).toBeNull(),
    );
    expect(
      screen.getByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeInTheDocument();
  });

  it("disables sending while the conversation is read-only", async () => {
    const { onSendSticker } = renderPicker({ readOnly: true });
    await openStickerTab();
    const panel = screen.getByRole("tabpanel", { name: "Sticker" });
    const tile = await within(panel).findByRole("button", { name: "Vỗ tay" });
    expect(tile).toHaveAttribute("aria-disabled", "true");
    expect(within(panel).getByRole("status")).toHaveTextContent(
      "Cuộc trò chuyện đang chỉ đọc nên chưa gửi được sticker.",
    );
    fireEvent.click(tile);
    expect(onSendSticker).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("ChatStickerView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const available: StickerEmbed = {
    kind: "sticker",
    available: true,
    sticker_id: "noto_animated:1f602",
    pack_id: "noto_animated",
    labels: { vi: "Cười ra nước mắt", en: "Tears of joy" },
    asset: stickers[1]?.asset,
  };

  it("renders borderless artwork with a reduced-motion source and no layout shift", () => {
    const { container } = render(
      <I18nProvider initialLanguage="en">
        <ChatStickerView embed={available} size={140} />
      </I18nProvider>,
    );
    const image = screen.getByRole("img", { name: "Tears of joy" });
    expect(image).toHaveAttribute("width", "140");
    expect(image).toHaveAttribute("height", "140");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
    const source = container.querySelector("picture > source");
    expect(source).toHaveAttribute("media", "(prefers-reduced-motion: reduce)");
    expect(source).toHaveAttribute(
      "srcset",
      "/stickers/noto_animated/v1/1f602.static.webp",
    );
  });

  it("plays only while on screen", () => {
    let notify: ((entries: { isIntersecting: boolean }[]) => void) | null =
      null;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          callback: (entries: { isIntersecting: boolean }[]) => void,
        ) {
          notify = callback;
        }
        disconnect = disconnect;
        observe() {}
      },
    );
    const view = render(
      <I18nProvider initialLanguage="vi">
        <ChatStickerView embed={available} />
      </I18nProvider>,
    );
    const image = screen.getByRole("img", { name: "Cười ra nước mắt" });
    expect(image).toHaveAttribute(
      "src",
      "/stickers/noto_animated/v1/1f602.static.webp",
    );
    act(() => notify?.([{ isIntersecting: true }]));
    expect(image).toHaveAttribute(
      "src",
      "/stickers/noto_animated/v1/1f602.webp",
    );
    act(() => notify?.([{ isIntersecting: false }]));
    expect(image).toHaveAttribute(
      "src",
      "/stickers/noto_animated/v1/1f602.static.webp",
    );
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("shows a compact unavailable card for removed stickers", () => {
    render(
      <I18nProvider initialLanguage="vi">
        <ChatStickerView embed={{ kind: "sticker", available: false }} />
      </I18nProvider>,
    );
    expect(screen.getByText("Sticker không còn khả dụng")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
