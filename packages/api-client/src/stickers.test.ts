import { describe, expect, it, vi } from "vitest";
import {
  APIRequestError,
  listStickerPacks,
  sendConversationMessage,
} from "./index";
import type {
  ActiveMessage,
  SendMessageRequest,
  StickerPackCatalog,
} from "./index";

// MSG-STICKER-01 (ADR-0047): sticker catalog and sticker embeds.
const tenantID = "7f44c093-1cb2-46ae-8285-779b78728524";
const conversationID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";

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
      stickers: [
        {
          id: "noto_animated:1f602",
          labels: { vi: "Cười ra nước mắt", en: "Tears of joy" },
          keywords: { vi: ["buồn cười"], en: ["lol"] },
          animated: true,
          asset: {
            animated_url: "/stickers/noto_animated/v1/1f602.webp",
            static_url: "/stickers/noto_animated/v1/1f602.static.webp",
            width: 160,
            height: 160,
          },
        },
      ],
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sticker API", () => {
  it("reads the catalog scoped to the expected tenant", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe(
        "/api/v1/conversations/sticker-packs",
      );
      expect(request.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
        tenantID,
      );
      expect(request.credentials).toBe("include");
      return jsonResponse(catalog);
    });

    await expect(
      listStickerPacks(tenantID, {
        baseUrl: "https://web.example.test/api",
        fetch: fetchMock,
      }),
    ).resolves.toEqual(catalog);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces feature_disabled so the picker can hide the Sticker tab", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          code: "feature_disabled",
          status: 403,
          title: "Feature disabled",
          type: "about:blank",
        },
        403,
      ),
    );
    const error = await listStickerPacks(tenantID, {
      baseUrl: "https://web.example.test/api",
      fetch: fetchMock,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(APIRequestError);
    expect((error as APIRequestError).status).toBe(403);
    expect((error as APIRequestError).problem?.code).toBe("feature_disabled");
  });

  it("rejects an empty tenant before sending", async () => {
    const fetchMock = vi.fn();
    await expect(listStickerPacks(" ", { fetch: fetchMock })).rejects.toThrow(
      TypeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a sticker as an embed-only message", async () => {
    const input = {
      client_message_id: "8e0131b2-9b49-487c-92ca-a240eeef0a66",
      content: "",
      embed: { kind: "sticker", sticker_id: "noto_animated:1f602" },
    } satisfies SendMessageRequest;
    const sent: ActiveMessage = {
      author: {
        display_name: "An",
        user_id: "5391c8b2-1224-4105-a44e-452eb69d9884",
      },
      client_message_id: input.client_message_id,
      content: "",
      conversation_id: conversationID,
      created_at: "2030-08-03T01:00:00Z",
      embed: {
        kind: "sticker",
        available: true,
        sticker_id: "noto_animated:1f602",
        pack_id: "noto_animated",
        labels: { vi: "Cười ra nước mắt", en: "Tears of joy" },
        asset: {
          animated_url: "/stickers/noto_animated/v1/1f602.webp",
          static_url: "/stickers/noto_animated/v1/1f602.static.webp",
          width: 160,
          height: 160,
        },
      },
      id: "b9170d5e-c354-44a8-9241-4571a5e26e57",
      sequence: 8,
      state: "active",
      updated_at: "2030-08-03T01:00:00Z",
      version: 1,
    };
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual(input);
      return jsonResponse(sent, 201);
    });

    await expect(
      sendConversationMessage(tenantID, conversationID, input, "csrf", {
        baseUrl: "https://web.example.test/api",
        fetch: fetchMock,
      }),
    ).resolves.toEqual(sent);
  });
});
