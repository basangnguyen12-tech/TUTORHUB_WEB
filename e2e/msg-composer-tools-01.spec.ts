import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { randomUUID } from "node:crypto";

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
];

interface Sent {
  attachments: number;
  directs: unknown[];
  messages: Record<string, unknown>[];
  spaces: Record<string, unknown>[];
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
          classroom_media_rooms: { enabled: true },
          instant_study_rooms: { enabled: true },
        },
        operations: {},
        quotas: {},
      });
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
      return json({ id: spaceID, status: "scheduled", version: 1 }, 201);
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
      return json(
        message(10 + sent.messages.length, {
          author: { user_id: teacherID, display_name: "Cô Mai" },
          client_message_id: body.client_message_id,
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

async function openComposer(page: Page, sent: Sent) {
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
      teacherID,
      tenantID,
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
      'const thread=h(ConversationMessages,{actorID:data.teacherID,canPostMessages:true,conversation:data.conversation,conversationID:data.conversation.id,formatter:new Intl.DateTimeFormat("vi-VN",{dateStyle:"medium",timeStyle:"short"}),tenantID:data.tenantID});',
      'const shell=h("div",{className:"conversations-page",style:{display:"flex",flexDirection:"column",height:"100dvh"}},thread);',
      'createRoot(document.getElementById("root")).render(h(query.QueryClientProvider,{client:new query.QueryClient({defaultOptions:{queries:{retry:false}}})},h(I18nProvider,{initialLanguage:"vi"},h(router.MemoryRouter,null,shell))));',
    ].join("\n");
    await route.fulfill({
      contentType: "text/html",
      body:
        '<!doctype html><html lang="vi"><head><title>Tin nhắn</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">' +
        bootstrap +
        "</script></body></html>",
    });
  });
  await page.goto(origin + entry);
  await expect(
    page.getByRole("textbox", { name: "Tin nhắn mới" }),
  ).toBeVisible();
}

async function expectNoAxeViolations(page: Page, label: string) {
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    // Radix menus and dialogs hide the page behind them with aria-hidden
    // while they own focus; that pattern predates this slice.
    .disableRules(["aria-hidden-focus"])
    .analyze();
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
  const sent: Sent = { attachments: 0, directs: [], messages: [], spaces: [] };
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
