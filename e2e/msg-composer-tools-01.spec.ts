import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// MSG-COMPOSER-TOOLS-01: the real ConversationMessages composer against a
// fixture Core API. Screen capture is a canvas stream standing in for the
// operating-system picker; nothing leaves the page.
const origin = "http://127.0.0.1:5173";
const entry = "/__msg-composer-tools-01";
const tenantID = randomUUID();
const conversationID = randomUUID();
const teacherID = randomUUID();
const studentID = randomUUID();
const spaceID = randomUUID();
const now = new Date().toISOString();

const classConversation = {
  id: conversationID,
  kind: "class",
  class_id: randomUUID(),
  title: "Lớp Toán 9A",
  participants: [],
  viewer_access: {
    can_post_messages: true,
    can_upload_attachments: true,
    can_moderate_chat: false,
  },
  participant_chat_enabled: true,
  unread_count: 0,
  unread_count_capped: false,
  created_at: now,
  updated_at: now,
};

function message(sequence: number, extra: Record<string, unknown>) {
  return {
    id: randomUUID(),
    conversation_id: conversationID,
    sequence,
    client_message_id: randomUUID(),
    author: { user_id: studentID, display_name: "Trần Minh Anh" },
    content: "",
    attachments: [],
    state: "active",
    version: 1,
    created_at: now,
    updated_at: now,
    ...extra,
  };
}

// MSG-STICKER-03: the fixture serves the real embedded catalog, projected
// like the Core API, so every sticker URL is a real same-origin WebP.
interface ManifestSticker {
  animated: boolean;
  id: string;
  keywords: { en: string[]; vi: string[] };
  labels: { en: string; vi: string };
  status: string;
}
interface ManifestPack {
  attribution: Record<string, string>;
  id: string;
  stickers: ManifestSticker[];
  title: { en: string; vi: string };
  version: string;
}
const manifest = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../services/core-api/internal/modules/conversation/stickers/catalog.json",
    ),
    "utf8",
  ),
) as { catalog_version: string; packs: ManifestPack[] };
const stickerCatalog = {
  catalog_version: manifest.catalog_version,
  packs: manifest.packs.map((pack) => ({
    id: pack.id,
    version: pack.version,
    title: pack.title,
    attribution: pack.attribution,
    stickers: pack.stickers
      .filter((sticker) => sticker.status === "active")
      .map((sticker) => {
        const base = `/stickers/${pack.id}/${pack.version}/${sticker.id.split(":")[1]}`;
        return {
          id: sticker.id,
          labels: sticker.labels,
          keywords: sticker.keywords,
          animated: sticker.animated,
          asset: {
            animated_url: `${base}.webp`,
            static_url: `${base}.static.webp`,
            width: 160,
            height: 160,
          },
        };
      }),
  })),
};
function stickerEmbed(stickerID: string) {
  for (const pack of stickerCatalog.packs) {
    const sticker = pack.stickers.find((item) => item.id === stickerID);
    if (sticker) {
      return {
        kind: "sticker",
        available: true,
        sticker_id: sticker.id,
        pack_id: pack.id,
        labels: sticker.labels,
        asset: sticker.asset,
      };
    }
  }
  return { kind: "sticker", available: false };
}

const history = [
  message(1, { content: "Thầy ơi em gửi danh thiếp bạn cùng nhóm ạ." }),
  message(2, {
    embed: {
      kind: "contact_card",
      available: true,
      user_id: randomUUID(),
      display_name: "Lê Thu Hà",
    },
  }),
  message(3, {
    author: { user_id: teacherID, display_name: "Cô Mai" },
    embed: {
      kind: "instant_class",
      media_space_id: spaceID,
      title: "Lớp học tạm thời 15 phút",
      status: "scheduled",
      ends_at: new Date(Date.now() + 592_000).toISOString(),
      remaining_seconds: 592,
      viewer_can_join: true,
    },
  }),
  // MSG-STICKER-03 / MSG-MENTION-BLUE-01.
  message(4, { embed: stickerEmbed("noto_animated:1f602") }),
  message(5, {
    content: "@Cô Mai làm xong đốt hết bao nhiêu bài ạ?",
  }),
];

interface Sent {
  attachments: number;
  directs: unknown[];
  messages: Record<string, unknown>[];
  spaces: Record<string, unknown>[];
  starts: Record<string, unknown>[];
}

async function coreApi(page: Page, sent: Sent) {
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split("/api/v1/").pop() ?? "";
    const method = request.method();
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        json: data,
        status,
        headers: { "cache-control": "no-store" },
      });
    if (path === "auth/csrf") return json({ csrf_token: "fixture" });
    if (method !== "GET" && request.headers()["x-csrf-token"] !== "fixture") {
      return json({ code: "csrf" }, 403);
    }
    if (path.endsWith("/capabilities")) {
      return json({
        tenant_id: tenantID,
        can_manage_overrides: false,
        features: {
          chat_stickers: { enabled: true },
          classroom_media_rooms: { enabled: true },
          instant_study_rooms: { enabled: true },
        },
        operations: {},
        quotas: {},
      });
    }
    if (path === "conversations/sticker-packs") {
      return json(stickerCatalog);
    }
    if (path === "conversations" && method === "GET") {
      return json({
        items: [
          {
            ...classConversation,
            id: randomUUID(),
            kind: "direct",
            class_id: undefined,
            title: "Trần Minh Anh",
            participants: [
              { user_id: teacherID, display_name: "Cô Mai" },
              { user_id: studentID, display_name: "Trần Minh Anh" },
            ],
          },
        ],
      });
    }
    if (path === "conversations/direct") {
      sent.directs.push(request.postDataJSON());
      return json(
        { ...classConversation, id: randomUUID(), kind: "direct" },
        201,
      );
    }
    if (path === "media/spaces") {
      sent.spaces.push(request.postDataJSON() as Record<string, unknown>);
      return json(
        {
          id: spaceID,
          status: "scheduled",
          version: 1,
          viewer_operations: { can_start: true },
        },
        201,
      );
    }
    if (path === `media/spaces/${spaceID}/start` && method === "POST") {
      sent.starts.push(request.postDataJSON() as Record<string, unknown>);
      return json({ id: spaceID, status: "open", version: 2 });
    }
    if (path.endsWith("/attachments") && method === "POST") {
      sent.attachments += 1;
      return json(
        {
          id: randomUUID(),
          conversation_id: conversationID,
          kind: "image",
          display_name: "screenshot.png",
          media_type: "image/png",
          size_bytes: 1024,
          width_px: 800,
          height_px: 450,
          created_at: now,
        },
        201,
      );
    }
    if (path.endsWith("/messages") && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      sent.messages.push(body);
      const embed = body.embed as
        { kind?: string; sticker_id?: string } | undefined;
      return json(
        message(10 + sent.messages.length, {
          author: { user_id: teacherID, display_name: "Cô Mai" },
          client_message_id: body.client_message_id,
          ...(embed?.kind === "sticker"
            ? { embed: stickerEmbed(embed.sticker_id ?? "") }
            : {}),
        }),
        201,
      );
    }
    if (path.endsWith("/messages")) {
      return json({
        items: [...history].reverse(),
        read_state: null,
        unread_count: 0,
        unread_count_capped: false,
      });
    }
    return json({ code: "not_found" }, 404);
  });
}

interface HarnessOptions {
  language?: "vi" | "en";
  /** MSG-STICKER-03: the classroom room chat panel instead of Messages. */
  surface?: "messages" | "room";
  theme?: "light" | "dark";
}

const roomConversation = {
  ...classConversation,
  id: randomUUID(),
  kind: "room",
  class_id: undefined,
  media_space_id: spaceID,
  media_space_status: "open",
  title: "Phòng học Toán 9A",
  viewer_access: {
    can_post_messages: true,
    can_upload_attachments: false,
    can_moderate_chat: false,
  },
};

async function openComposer(
  page: Page,
  sent: Sent,
  options: HarnessOptions = {},
) {
  const language = options.language ?? "vi";
  const surface = options.surface ?? "messages";
  await page.routeWebSocket("ws://127.0.0.1:5173/**", () => {});
  await page.addInitScript(() => {
    // Stand-in for the operating-system picker: a drawn canvas stream.
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia: async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 1280;
          canvas.height = 720;
          const context = canvas.getContext("2d");
          const draw = () => {
            if (!context) return;
            context.fillStyle = "#e8f1f8";
            context.fillRect(0, 0, 1280, 720);
            context.fillStyle = "#124d80";
            context.font = "bold 48px sans-serif";
            context.fillText("Bài 3: phương trình bậc hai", 80, 160);
          };
          draw();
          const timer = window.setInterval(draw, 100);
          const stream = canvas.captureStream(10);
          for (const track of stream.getTracks()) {
            const stop = track.stop.bind(track);
            track.stop = () => {
              window.clearInterval(timer);
              stop();
              (window as unknown as { stopped: number }).stopped =
                ((window as unknown as { stopped?: number }).stopped ?? 0) + 1;
            };
          }
          return stream;
        },
      },
    });
  });
  await coreApi(page, sent);
  await page.route("**" + entry, async (route) => {
    const sources = await Promise.all(
      [
        "/src/components/ConversationMessages.tsx",
        "/src/app/conversations.ts",
      ].map(async (path) => (await page.request.get(origin + path)).text()),
    );
    function dep(suffix: string) {
      for (const source of sources) {
        for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
          const url = match[1] ?? "";
          if (url.split("?")[0]?.endsWith("/" + suffix))
            return JSON.stringify(url);
        }
      }
      throw new Error("Vite composer dependency is missing: " + suffix);
    }
    const data = JSON.stringify({
      conversation: classConversation,
      language,
      messages: history,
      room: roomConversation,
      surface,
      teacherID,
      tenantID,
      theme: options.theme ?? "light",
    });
    const bootstrap = [
      'import Refresh from "/@react-refresh"; Refresh.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => t => t; window.__vite_plugin_react_preamble_installed__ = true;',
      "const React=(await import(" + dep("react.js") + ")).default;",
      "const router=await import(" + dep("react-router.js") + ");",
      "const query=await import(" + dep("@tanstack_react-query.js") + ");",
      "const {I18nProvider}=await import(" + dep("i18n.tsx") + ");",
      'const {ConversationMessages}=await import("/src/components/ConversationMessages.tsx");',
      'const {createRoot}=(await import("/@id/react-dom/client")).default;',
      'await Promise.all([import("/src/styles.css"),import("/src/pages/ConversationsPage.css"),import("/@id/@tutorhub/design-tokens/tokens.css"),import("/@id/@tutorhub/ui/styles.css")]);',
      "const data=" + data + "; const h=React.createElement;",
      'document.documentElement.lang=data.language; if(data.theme==="dark"){document.documentElement.dataset.theme="dark";}',
      'const thread=h(ConversationMessages,{actorID:data.teacherID,canPostMessages:true,conversation:data.conversation,conversationID:data.conversation.id,formatter:new Intl.DateTimeFormat(data.language==="vi"?"vi-VN":"en-US",{dateStyle:"medium",timeStyle:"short"}),tenantID:data.tenantID});',
      'let shell=h("div",{className:"conversations-page",style:{display:"flex",flexDirection:"column",height:"100dvh",background:"var(--msg-surface)"}},thread);',
      'if(data.surface==="room"){await import("/src/pages/ClassroomRoomStage.css"); const {ClassroomChatPanel}=await import("/src/features/media/ClassroomChatPanel.tsx"); const noop=async()=>{}; const panel=h(ClassroomChatPanel,{actorID:data.teacherID,conversation:data.room,hasOlder:false,loadingOlder:false,messages:data.messages.map((item)=>({...item,conversation_id:data.room.id})),open:true,tenantID:data.tenantID,loadAttachment:async()=>new Blob(),onDelete:noop,onEdit:noop,onLoadOlder:()=>{},onSend:noop,onToggleParticipantChat:noop,onUpload:async()=>{throw new Error("uploads are off");}}); shell=h("div",{style:{display:"flex",justifyContent:"flex-end",height:"100dvh",background:"#0f131a"}},h("aside",{"aria-label":"Chat",style:{display:"flex",flexDirection:"column",width:"min(400px, 100vw)",height:"100%"}},panel));}',
      'createRoot(document.getElementById("root")).render(h(query.QueryClientProvider,{client:new query.QueryClient({defaultOptions:{queries:{retry:false}}})},h(I18nProvider,{initialLanguage:data.language},h(router.MemoryRouter,null,shell))));',
    ].join("\n");
    await route.fulfill({
      contentType: "text/html",
      body:
        `<!doctype html><html lang="${language}"><head><title>${language === "vi" ? "Tin nhắn" : "Messages"}</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module">` +
        bootstrap +
        "</script></body></html>",
    });
  });
  await page.goto(origin + entry);
  if (surface === "room") {
    await expect(page.locator(".classroom-chat__input")).toBeVisible();
  } else {
    await expect(
      page.getByRole("textbox", {
        name: language === "vi" ? "Tin nhắn mới" : "New message",
      }),
    ).toBeVisible();
  }
}

/** Evidence screenshots only when MSG_STICKER_EVIDENCE_DIR is set. */
async function evidence(page: Page, name: string, target?: Locator) {
  const directory = process.env.MSG_STICKER_EVIDENCE_DIR?.trim();
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const file = path.resolve(directory, `${name}.png`);
  if (target) await target.screenshot({ path: file });
  else await page.screenshot({ path: file });
}

async function expectNoAxeViolations(
  page: Page,
  label: string,
  include?: string,
) {
  let builder = new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    // Radix menus and dialogs hide the page behind them with aria-hidden
    // while they own focus; that pattern predates this slice.
    .disableRules(["aria-hidden-focus"]);
  if (include) builder = builder.include(include);
  const report = await builder.analyze();
  expect(
    report.violations.map(
      (violation) => `${violation.id}: ${violation.nodes.length}`,
    ),
    label,
  ).toEqual([]);
}

test.skip(
  process.env.E2E_MODE?.trim() === "staging",
  "Vite composer fixture harness runs only against the local Vite server.",
);

test("composer tools capture, share cards and stay accessible", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent: Sent = {
    attachments: 0,
    directs: [],
    messages: [],
    spaces: [],
    starts: [],
  };
  await openComposer(page, sent);

  // Toolbar in the ClassIn order, with the cards rendered from embeds only.
  const tools = page.locator(".conversation-composer__tools > *");
  await expect(tools).toHaveCount(7);
  await expect(
    page.getByRole("region", { name: "Danh thiếp của Lê Thu Hà" }),
  ).toBeVisible();
  const classCard = page.getByRole("region", {
    name: "Lớp học tạm thời Lớp học tạm thời 15 phút",
  });
  await expect(
    classCard.getByRole("link", { name: "Vào lớp" }),
  ).toHaveAttribute("href", `/app/media/spaces/${spaceID}/prejoin`);
  await expect(classCard).toContainText(/09:5\d/);
  await expectNoAxeViolations(page, "thread and composer");

  // Screenshot: picker, crop, staged upload, send.
  const capture = page.getByRole("button", {
    name: "Chụp màn hình (Ctrl+Alt+X)",
  });
  await expect(capture).toHaveAttribute("aria-keyshortcuts", "Control+Alt+X");
  await capture.click();
  await page.getByRole("menuitem", { name: /^Chụp màn hình/ }).click();
  const editor = page.getByRole("dialog", { name: "Cắt ảnh chụp màn hình" });
  await expect(editor).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { stopped?: number }).stopped ?? 0,
      ),
    )
    .toBe(1);
  await expectNoAxeViolations(page, "crop dialog");
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press("Shift+ArrowLeft");
  }
  await page.keyboard.press("Enter");
  await expect(editor).toBeHidden();
  await expect(page.getByText(/^screenshot-\d{8}-\d{6}\.png$/)).toBeVisible();
  await expect.poll(() => sent.attachments).toBe(1);
  await expect(
    page.getByRole("textbox", { name: "Tin nhắn mới" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Gửi tin nhắn" }).click();
  await expect.poll(() => sent.messages.length).toBe(1);
  expect(sent.messages[0]).toMatchObject({
    content: "",
    attachment_ids: [expect.any(String)],
  });

  // Contact card.
  await page.getByRole("button", { name: "Gửi danh thiếp" }).click();
  const contactDialog = page.getByRole("dialog", { name: "Gửi danh thiếp" });
  await expect(contactDialog.getByRole("radio")).toHaveCount(2);
  await expectNoAxeViolations(page, "contact dialog");
  await contactDialog.getByRole("radio", { name: /Trần Minh Anh/ }).check();
  await contactDialog.getByRole("button", { name: "Gửi danh thiếp" }).click();
  await expect(contactDialog).toBeHidden();
  await expect.poll(() => sent.messages.length).toBe(2);
  expect(sent.messages[1]).toMatchObject({
    content: "",
    embed: { kind: "contact_card", user_id: studentID },
  });

  // Instant class: create the space, then share it as a card.
  await page.getByRole("button", { name: "Lớp học tạm thời" }).click();
  // The title follows the chosen duration, so locate the open dialog itself.
  const classDialog = page.getByRole("dialog");
  await expect(classDialog).toHaveAccessibleName("Lớp học tạm thời 15 phút");
  await expectNoAxeViolations(page, "instant class dialog");
  await classDialog.getByRole("radio", { name: "30 phút" }).check();
  await expect(
    classDialog.getByRole("textbox", { name: "Tên lớp" }),
  ).toHaveValue("Lớp học tạm thời 30 phút");
  await classDialog.getByRole("button", { name: "Tạo" }).click();
  await expect(page.getByText("Tạo lớp học thành công.")).toBeVisible();
  expect(sent.spaces[0]).toMatchObject({
    source: {
      kind: "instant",
      duration_minutes: 30,
      title: "Lớp học tạm thời 30 phút",
    },
  });
  expect(sent.starts[0]).toMatchObject({
    expected_version: 1,
    reason_code: "product_launch",
  });
  await expect.poll(() => sent.messages.length).toBe(3);
  expect(sent.messages[2]).toMatchObject({
    embed: { kind: "instant_class", media_space_id: spaceID },
  });

  // "Message" on a contact card opens a direct chat through the card.
  await page
    .getByRole("region", { name: "Danh thiếp của Lê Thu Hà" })
    .getByRole("button", { name: "Nhắn tin" })
    .click();
  await expect.poll(() => sent.directs.length).toBe(1);
  expect(sent.directs[0]).toMatchObject({ source_message_id: history[1]?.id });

  expect(errors).toEqual([]);
  await context.close();
});

test("composer tools fit a 375 px phone without horizontal scroll", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
  });
  const page = await context.newPage();
  await openComposer(page, {
    attachments: 0,
    directs: [],
    messages: [],
    spaces: [],
    starts: [],
  });
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  for (const name of ["Gửi danh thiếp", "Lớp học tạm thời", "Gửi tệp"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
  await context.close();
});

// ---- MSG-STICKER-03 (ADR-0047) and MSG-MENTION-BLUE-01 -------------------

const copy = {
  vi: {
    composer: "Tin nhắn mới",
    roomComposer: "Nội dung tin nhắn",
    emoji: "Biểu tượng cảm xúc",
    searchStickers: "Tìm sticker",
    query: "cuoi ra nuoc",
    sticker: "Cười ra nước mắt",
    mentionDraft: "@Trần Minh Anh làm xong đốt hết bao nhiêu?",
  },
  en: {
    composer: "New message",
    roomComposer: "Message text",
    emoji: "Emoji",
    searchStickers: "Search stickers",
    query: "tears",
    sticker: "Tears of joy",
    mentionDraft: "@Trần Minh Anh how many did you finish?",
  },
} as const;

const mentionInk = {
  light: "rgb(11, 92, 189)",
  dark: "rgb(121, 184, 232)",
} as const;

function emptySent(): Sent {
  return { attachments: 0, directs: [], messages: [], spaces: [], starts: [] };
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectInsideViewport(page: Page, target: Locator) {
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
}

const variants = [
  {
    name: "1440-light-vi",
    width: 1440,
    height: 900,
    theme: "light",
    language: "vi",
    reducedMotion: "no-preference",
  },
  {
    name: "375-light-en",
    width: 375,
    height: 812,
    theme: "light",
    language: "en",
    reducedMotion: "no-preference",
  },
  {
    name: "320-dark-vi",
    width: 320,
    height: 720,
    theme: "dark",
    language: "vi",
    reducedMotion: "no-preference",
  },
  {
    name: "1440-dark-en-reduced-motion",
    width: 1440,
    height: 900,
    theme: "dark",
    language: "en",
    reducedMotion: "reduce",
  },
] as const;

for (const variant of variants) {
  test(`stickers and blue mentions in Messages (${variant.name})`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: variant.width, height: variant.height },
      reducedMotion: variant.reducedMotion,
      colorScheme: variant.theme,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sent = emptySent();
    const text = copy[variant.language];
    await openComposer(page, sent, {
      language: variant.language,
      theme: variant.theme,
    });

    // A sticker message: borderless, explicit size, real same-origin WebP.
    const sticker = page.getByRole("img", { name: text.sticker }).first();
    await sticker.scrollIntoViewIfNeeded();
    await expect(sticker).toBeVisible();
    await expect(sticker).toHaveAttribute("width", "140");
    await expect
      .poll(() =>
        sticker.evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    const currentSource = () =>
      sticker.evaluate((image) => (image as HTMLImageElement).currentSrc);
    if (variant.reducedMotion === "reduce") {
      await expect.poll(currentSource).toMatch(/1f602\.static\.webp$/);
    } else {
      await expect.poll(currentSource).toMatch(/1f602\.webp$/);
    }
    const stickerRow = page.locator(".conversation-message", {
      has: sticker,
    });
    await expect(
      stickerRow.locator(".conversation-message__bubble--sticker"),
    ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await evidence(page, `messages-thread-sticker-${variant.name}`, stickerRow);

    // Zalo-style blue @mention in a sent bubble; the rest keeps normal ink.
    const mention = page
      .locator(".conversation-message .conversation-mention", {
        hasText: "@Cô Mai",
      })
      .first();
    await mention.scrollIntoViewIfNeeded();
    await expect(mention).toHaveCSS("color", mentionInk[variant.theme]);
    await evidence(
      page,
      `mention-bubble-${variant.name}`,
      page.locator("li.conversation-message", {
        has: page.locator(".conversation-mention", { hasText: "@Cô Mai" }),
      }),
    );

    // Blue @mention inside the composer (mirror under the textarea).
    const composer = page.getByRole("textbox", { name: text.composer });
    await composer.fill(text.mentionDraft);
    const mirror = page.locator(".conversation-composer__mirror");
    await expect(mirror).toHaveAttribute("aria-hidden", "true");
    await expect(
      mirror.locator(".conversation-mention", { hasText: "@Trần Minh Anh" }),
    ).toHaveCSS("color", mentionInk[variant.theme]);
    await expect(composer).toHaveAttribute("spellcheck", "false");
    await expect(composer).toHaveCSS("color", "rgba(0, 0, 0, 0)");
    // The mirror text sits exactly over the textarea text box.
    const [field, mirrorBox] = await Promise.all([
      composer.boundingBox(),
      mirror.boundingBox(),
    ]);
    expect(mirrorBox).toEqual(field);
    await evidence(
      page,
      `mention-composer-${variant.name}`,
      page.locator(".conversation-composer"),
    );
    await expectNoAxeViolations(page, `thread with mentions ${variant.name}`);

    // Sticker | Emoji picker.
    await page.getByRole("button", { name: text.emoji }).click();
    const stickerTab = page.getByRole("tab", { name: "Sticker" });
    await stickerTab.click();
    await expect(stickerTab).toHaveAttribute("aria-selected", "true");
    const popover = page.locator(".chat-expression__popover");
    const panel = page.getByRole("tabpanel", { name: "Sticker" });
    const firstTile = panel.locator(".chat-sticker__cell img").first();
    await expect
      .poll(() =>
        firstTile.evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(firstTile).toHaveAttribute("src", /\.static\.webp$/);
    await expect(
      panel.getByRole("link", { name: /CC BY 4\.0/ }),
    ).toHaveAttribute("href", "/THIRD_PARTY_NOTICES.txt");
    await expectInsideViewport(page, popover);
    await noHorizontalScroll(page);
    await expectNoAxeViolations(page, `sticker tab ${variant.name}`);
    await evidence(page, `picker-sticker-tab-${variant.name}`, popover);
    await evidence(page, `page-sticker-tab-${variant.name}`);

    // Accent-free search, then send immediately without losing the draft.
    await panel
      .getByRole("searchbox", { name: text.searchStickers })
      .fill(text.query);
    const result = panel.getByRole("button", { name: text.sticker });
    await expect(result).toBeVisible();
    await result.hover();
    if (variant.reducedMotion === "reduce") {
      await expect(result.locator("img")).toHaveAttribute(
        "src",
        /\.static\.webp$/,
      );
    } else {
      await expect(result.locator("img")).toHaveAttribute(
        "src",
        /1f602\.webp$/,
      );
    }
    await result.click();
    await expect(popover).toBeHidden();
    await expect.poll(() => sent.messages.length).toBe(1);
    expect(sent.messages[0]).toEqual({
      client_message_id: expect.any(String),
      content: "",
      embed: { kind: "sticker", sticker_id: "noto_animated:1f602" },
    });
    await expect(composer).toHaveValue(text.mentionDraft);
    await expect(composer).toBeFocused();

    // Emoji tab is the existing ROOM-CHAT-EMOJI-02 picker.
    await page.getByRole("button", { name: text.emoji }).click();
    await expect(stickerTab).toHaveAttribute("aria-selected", "true");
    await stickerTab.press("ArrowRight");
    const emojiTab = page.getByRole("tab", { name: "Emoji" });
    await expect(emojiTab).toBeFocused();
    await expect(page.getByRole("tabpanel", { name: "Emoji" })).toBeVisible();
    await expectNoAxeViolations(page, `emoji tab ${variant.name}`);
    await evidence(page, `picker-emoji-tab-${variant.name}`, popover);
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(page.getByRole("button", { name: text.emoji })).toBeFocused();

    expect(errors).toEqual([]);
    await context.close();
  });
}

for (const variant of [
  { name: "room-1440-vi", width: 1440, height: 900, language: "vi" },
  { name: "room-375-en", width: 375, height: 812, language: "en" },
] as const) {
  test(`room chat offers the same Sticker | Emoji picker (${variant.name})`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: variant.width, height: variant.height },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sent = emptySent();
    const text = copy[variant.language];
    await openComposer(page, sent, {
      language: variant.language,
      surface: "room",
      theme: "dark",
    });

    const sticker = page.getByRole("img", { name: text.sticker }).first();
    await sticker.scrollIntoViewIfNeeded();
    await expect(sticker).toHaveAttribute("width", "128");
    await expect(
      page.locator(".classroom-chat__mention", { hasText: "@Cô Mai" }),
    ).toHaveCSS("color", "rgb(147, 197, 253)");
    await evidence(page, `room-thread-${variant.name}`);

    const composer = page.getByRole("textbox", { name: text.roomComposer });
    await composer.fill("Em chưa hiểu câu 2");
    await page.getByRole("button", { name: text.emoji }).click();
    await page.getByRole("tab", { name: "Sticker" }).click();
    const panel = page.getByRole("tabpanel", { name: "Sticker" });
    await panel
      .getByRole("searchbox", { name: text.searchStickers })
      .fill(text.query);
    await expect(
      panel.getByRole("button", { name: text.sticker }),
    ).toBeVisible();
    await expectNoAxeViolations(
      page,
      `room sticker tab ${variant.name}`,
      ".classroom-chat",
    );
    await expectInsideViewport(page, page.locator(".chat-expression__popover"));
    await evidence(page, `room-picker-sticker-tab-${variant.name}`);
    await panel.getByRole("button", { name: text.sticker }).click();
    await expect.poll(() => sent.messages.length).toBe(1);
    expect(sent.messages[0]).toMatchObject({
      content: "",
      embed: { kind: "sticker", sticker_id: "noto_animated:1f602" },
    });
    await expect(composer).toHaveValue("Em chưa hiểu câu 2");
    await expect(composer).toBeFocused();
    expect(errors).toEqual([]);
    await context.close();
  });
}
