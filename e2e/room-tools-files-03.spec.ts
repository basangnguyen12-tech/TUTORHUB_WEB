import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";

const origin = "http://127.0.0.1:5173";
const entry = "/__room-tools-files-03";
const tenantID = randomUUID();
const spaceID = randomUUID();
const instanceID = randomUUID();
const fileID = randomUUID();
const presentationID = randomUUID();
const conversationID = randomUUID();
const attachmentID = randomUUID();
const name = "Phieu-on-tap.pdf";
const actors = {
  teacher: randomUUID(),
  alice: randomUUID(),
  bob: randomUUID(),
};
type Actor = keyof typeof actors;
type Entry = { page: number; text: string };
const notes = new Map<Actor, { version: number; entries: Entry[] }>();
const grants = new Map<string, { actorId: string; capability: string }>();
const docName = "pd_" + presentationID.replaceAll("-", "");
const checksum = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function worksheet() {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 /MediaBox [0 0 420 595] /Resources << /Font << /F1 3 0 R >> >> >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let n = 1; n <= 2; n++) {
    const stream = "BT /F1 16 Tf 40 500 Td (Equation " + n + ") Tj ET";
    bodies.push(
      "<< /Type /Page /Parent 2 0 R /Contents " + (3 + n * 2) + " 0 R >>",
      "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
    );
  }
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const body of bodies) {
    offsets.push(pdf.length);
    pdf += offsets.length + " 0 obj\n" + body + "\nendobj\n";
  }
  const offset = pdf.length;
  pdf += "xref\n0 8\n0000000000 65535 f \n";
  for (const pos of offsets)
    pdf += String(pos).padStart(10, "0") + " 00000 n \n";
  return Buffer.from(
    pdf +
      "trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n" +
      offset +
      "\n%%EOF\n",
  );
}

const bytes = worksheet();
const timestamp = new Date().toISOString();
const attachment = {
  id: attachmentID,
  conversation_id: conversationID,
  created_at: timestamp,
  display_name: name,
  media_type: "application/pdf",
  kind: "file",
  size_bytes: bytes.length,
};
const messages: {
  id: string;
  attachments: (typeof attachment)[];
  content: string;
  client_message_id: string;
  author: { display_name: string; user_id: string };
  sequence: number;
  conversation_id: string;
  created_at: string;
  updated_at: string;
  state: string;
  version: number;
}[] = [];
let saved = false;
let presented = false;
let allowDownload = false;
let uploaded = false;
let providerUrl = "";
const storageUrl = origin + "/__document-bytes?fixture=private";
function projection(actor: Actor) {
  const teacher = actor === "teacher";
  return {
    id: presentationID,
    file_id: fileID,
    media_space_id: spaceID,
    current_generation: 1,
    revoke_generation: 1,
    version: 1,
    status: "open",
    page_count: 2,
    version_id: "v1",
    created_at: timestamp,
    updated_at: timestamp,
    document: {
      file_id: fileID,
      display_name: name,
      media_type: "application/pdf",
      version_id: "v1",
      page_count: 2,
      first_page_aspect: 420 / 595,
      active_content: false,
      allow_student_download: allowDownload,
    },
    viewer_capabilities: {
      capability: teacher ? "present" : "view",
      can_manage: teacher,
      can_exchange_grant: true,
      can_manage_annotator_grants: teacher,
      can_suspend: teacher,
      can_close: teacher,
      can_resume: false,
    },
  };
}

function row(actor: Actor) {
  return {
    id: fileID,
    media_space_id: spaceID,
    owner_kind: "media_space",
    class_id: null,
    status: "ready",
    display_name: name,
    declared_media_type: "application/pdf",
    expected_size_bytes: bytes.length,
    active_content: false,
    allow_student_download: allowDownload,
    expires_at: null,
    first_page_aspect: 420 / 595,
    rejection_reason: null,
    page_count: 2,
    uploaded_by_viewer: actor === "teacher",
    version: allowDownload ? 2 : 1,
    updated_at: timestamp,
    created_at: timestamp,
    viewer_access: {
      can_view: true,
      can_manage: actor === "teacher",
      can_download_original: actor === "teacher" || allowDownload,
      can_retry_upload: false,
    },
  };
}
async function coreApi(page: Page, actor: Actor) {
  const teacher = actor === "teacher";
  await page.route("**/__document-bytes?*", (route) =>
    route.fulfill({ contentType: "application/pdf", body: bytes }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.split("/api/v1/").pop()!;
    const method = req.method();
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        json: data,
        status,
        headers: { "cache-control": "no-store" },
      });
    if (p === "auth/csrf") return json({ csrf_token: "fixture" });
    if (method !== "GET" && req.headers()["x-csrf-token"] !== "fixture")
      return json({ code: "csrf" }, 403);
    if (p.endsWith("/capabilities"))
      return json({
        tenant_id: tenantID,
        features: {
          classroom_whiteboards: { enabled: false },
          classroom_code_tool: { enabled: false },
          file_uploads: { enabled: true },
          classroom_files_tool: { enabled: true },
          classroom_pdf_collaboration: { enabled: true },
        },
      });
    if (p === "media/spaces/" + spaceID)
      return json({
        id: spaceID,
        status: "open",
        version: 1,
        source: { kind: "study_meeting" },
        active_room_instance: { id: instanceID, status: "active", version: 1 },
        viewer_operations: { can_manage_admissions: false },
      });
    if (p.endsWith("/participants"))
      return json({
        room_instance_id: instanceID,
        projection_version: 1,
        last_signal_sequence: 0,
        self_participant_key: actors[actor],
        server_time: new Date().toISOString(),
        participants: Object.entries(actors).map(([key, id], i) => ({
          participant_key: id,
          display_name: key,
          instance_role: key === "teacher" ? "host" : "attendee",
          connection_state: "connected",
          roster_sequence: i + 1,
        })),
        raised_hands: [],
        reaction_clusters: [],
        viewer_operations: {
          can_raise_hand: true,
          can_send_reaction: true,
          can_moderate_hands: teacher,
        },
      });
    if (p.endsWith("/diagnostics")) return json({});
    if (p.endsWith("/conversation") || p === "conversations/" + conversationID)
      return json({
        id: conversationID,
        kind: "room",
        media_space_id: spaceID,
        media_space_status: "open",
        participant_chat_enabled: true,
        participants: [],
        title: "Lớp Toán",
        unread_count: 0,
        unread_count_capped: false,
        updated_at: timestamp,
        created_at: timestamp,
        viewer_access: {
          can_post_messages: true,
          can_upload_attachments: true,
          can_moderate_chat: teacher,
        },
      });
    if (p.endsWith("/attachments") && method === "POST") {
      expect(req.postDataBuffer()?.includes(bytes)).toBe(true);
      uploaded = true;
      return json(attachment, 201);
    }
    if (p.endsWith("/attachments/" + attachmentID + "/content") && uploaded)
      return route.fulfill({ body: bytes, contentType: "application/pdf" });
    if (p.endsWith("/messages") && method === "GET")
      return json({
        items: [...messages].reverse(),
        read_state: null,
        unread_count: 0,
        unread_count_capped: false,
      });
    if (p.endsWith("/messages") && method === "POST") {
      const input = req.postDataJSON();
      const message = {
        attachments:
          input.attachment_ids?.includes(attachmentID) && uploaded
            ? [attachment]
            : [],
        author: { display_name: actor, user_id: actors[actor] },
        client_message_id: input.client_message_id,
        content: input.content,
        conversation_id: conversationID,
        created_at: timestamp,
        id: randomUUID(),
        sequence: messages.length + 1,
        state: "active",
        updated_at: timestamp,
        version: 1,
      };
      messages.push(message);
      return json(message, 201);
    }
    if (p.endsWith("/documents") && method === "GET")
      return json({
        items: saved ? [row(actor)] : [],
        next_cursor: null,
        viewer_access: {
          can_manage: teacher,
          can_present: teacher,
          can_upload: teacher,
          can_upload_to_class: false,
        },
      });
    if (p.endsWith("/from-chat-attachment") && method === "POST" && teacher) {
      const body = req.postDataJSON();
      expect(body.attachment_id).toBe(attachmentID);
      expect(body.conversation_id).toBe(conversationID);
      expect(body.client_request_id).toMatch(/^[0-9a-f-]{36}$/i);
      saved = true;
      return json(row(actor), 201);
    }
    if (p.endsWith("/documents/" + fileID) && method === "PATCH" && teacher) {
      allowDownload = req.postDataJSON().allow_student_download;
      return json(row(actor));
    }
    if (p.endsWith("/view-capabilities") && saved)
      return json({
        method: "GET",
        url: storageUrl,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        active_content: false,
        content_length_bytes: bytes.length,
        first_page_aspect: 420 / 595,
        media_type: "application/pdf",
        page_count: 2,
        sha256: checksum(bytes),
        version_id: "v1",
      });
    if (p.endsWith("/download-capability"))
      return teacher || allowDownload
        ? json({
            method: "GET",
            expires_at: new Date(Date.now() + 60000).toISOString(),
            url: storageUrl,
          })
        : json({ code: "forbidden" }, 403);
    if (p.endsWith("/pdf-presentation") && method === "GET")
      return json({
        active_annotator_grants: [],
        can_present: teacher,
        presentation: presented ? projection(actor) : null,
      });
    if (
      p.endsWith("/pdf-presentation") &&
      method === "POST" &&
      saved &&
      teacher
    ) {
      presented = true;
      return json(projection(actor), 201);
    }
    if (p.endsWith("/grant-exchanges") && presented) {
      const capability = teacher ? "present" : "view";
      expect(req.postDataJSON().capability).toBe(capability);
      const credential = randomUUID();
      grants.set(credential, { actorId: actors[actor], capability });
      return json({
        document_id: presentationID,
        credential,
        capability,
        generation: 1,
        provider_url: providerUrl,
        revoke_generation: 1,
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });
    }
    if (saved && p.endsWith("/documents/" + fileID + "/study-note")) {
      let record = notes.get(actor) ?? { entries: [], version: 0 };
      if (method === "PUT") {
        const body = req.postDataJSON();
        if (body.expected_version !== record.version)
          return json({ code: "room_document_version_conflict" }, 409);
        record = { entries: body.entries, version: record.version + 1 };
        notes.set(actor, record);
      }
      return json({
        ...record,
        file_id: fileID,
        byte_length: 0,
        updated_at: null,
        expires_at: null,
      });
    }
    return json({ code: "not_found" }, 404);
  });
}

interface Runtime {
  address: { port: number };
  listen(): Promise<unknown>;
  destroy(): Promise<void>;
}
let runtime: Runtime;
test.beforeAll(async () => {
  const requireRuntime = createRequire(
    path.resolve("services/whiteboard-runtime/package.json"),
  );
  const { Server } = requireRuntime("@hocuspocus/server") as {
    Server: new (options: Record<string, unknown>) => Runtime;
  };
  runtime = new Server({
    address: "127.0.0.1",
    port: 0,
    quiet: true,
    stopOnSignals: false,
    onAuthenticate({
      token,
      documentName,
      connectionConfig,
    }: {
      token: string;
      documentName: string;
      connectionConfig: { readOnly: boolean };
    }) {
      const grant = grants.get(token);
      if (!grant || documentName !== docName)
        throw new Error("invalid fixture grant");
      connectionConfig.readOnly = grant.capability === "view";
      return grant;
    },
    beforeHandleAwareness({
      states,
      context,
    }: {
      states: Map<number, Record<string, unknown>>;
      context: { actorId: string; capability: string };
    }) {
      for (const value of states.values())
        value.tutorhub = { ...context, generation: 1 };
    },
  });
  await runtime.listen();
  providerUrl = "ws://127.0.0.1:" + runtime.address.port;
});
test.afterAll(async () => {
  await runtime?.destroy();
});
test.skip(
  process.env.E2E_MODE === "staging",
  "This exercise runs against the local media fixture.",
);

async function mount(browser: Browser, actor: Actor) {
  const context = await browser.newContext({
    baseURL: origin,
    locale: "vi-VN",
    permissions: ["local-network-access"],
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  // A file edit in the development server must not reload a classroom during
  // an exercise. The presentation provider uses its own loopback port.
  await page.routeWebSocket("ws://127.0.0.1:5173/**", () => {});
  await page.addInitScript(() => {
    // The SDK's synthetic remote camera constructs an RTP receiver directly.
    Object.defineProperty(window, "RTCRtpReceiver", {
      configurable: true,
      value: class FixtureReceiver {
        playoutDelayHint: number | null = null;
        async getStats() {
          return new Map();
        }
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await coreApi(page, actor);
  // Exercise the real room page, LiveKit shell and product handlers. Replace
  // the transport handshake alone with the SDK's own camera simulation.
  await page.route(
    "**/src/features/media/ClassroomLiveKitRoom.tsx*",
    async (route) => {
      const original = await route.fetch();
      const source = await original.text();
      const call =
        /\.connect\(\s*credential\.server_url,\s*credential\.access_token,\s*manualSubscriptionConnectOptions,?\s*\)/u;
      expect(source).toMatch(call);
      await route.fulfill({
        response: original,
        body: source.replace(
          call,
          ".simulateParticipants({publish:{audio:false,video:false,useRealTracks:false},participants:{count:2,video:true}}).then(() => {" +
            "const keys=" +
            JSON.stringify([
              actors[actor],
              actor === "teacher" ? actors.alice : actors.teacher,
            ]) +
            ";" +
            "[room.localParticipant,...room.remoteParticipants.values()].forEach((p,i)=>{Object.defineProperty(p,'_attributes',{configurable:true,value:{'tutorhub.participant_key':keys[i]}});room.emit(RoomEvent.ParticipantAttributesChanged,p.attributes,p);});})",
        ),
      });
    },
  );
  await page.route("**" + entry, async (route) => {
    const source = await (
      await page.request.get(origin + "/src/pages/MediaSpaceRoomPage.tsx")
    ).text();
    function dep(suffix: string) {
      const urls = Array.from(
        source.matchAll(/from\s+"([^"]+)"/g),
        (m) => m[1]!,
      );
      const result = urls.find((url) =>
        url.split("?")[0]?.endsWith("/" + suffix),
      );
      if (!result)
        throw new Error("Vite room dependency is missing: " + suffix);
      return JSON.stringify(result);
    }
    const role = actor === "teacher" ? "org_admin" : "member";
    const data = JSON.stringify({
      tenantID,
      spaceID,
      instanceID,
      actorID: actors[actor],
      role,
      actor,
    });
    const bootstrap = [
      'import Refresh from "/@react-refresh"; Refresh.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => t => t; window.__vite_plugin_react_preamble_installed__ = true;',
      "const React=(await import(" + dep("react.js") + ")).default;",
      "const router=await import(" + dep("react-router.js") + ");",
      "const query=await import(" + dep("@tanstack_react-query.js") + ");",
      "const {SessionProvider}=await import(" + dep("session.tsx") + ");",
      "const {I18nProvider}=await import(" + dep("i18n.tsx") + ");",
      "const prejoin=await import(" + dep("mediaPrejoin.ts") + ");",
      'const {MediaSpaceRoomPage}=await import("/src/pages/MediaSpaceRoomPage.tsx");',
      'const {createRoot}=(await import("/@id/react-dom/client")).default;',
      'await Promise.all([import("/src/styles.css"),import("/@id/@tutorhub/design-tokens/tokens.css"),import("/@id/@tutorhub/ui/styles.css")]);',
      "const data=" + data + "; const h=React.createElement;",
      'prejoin.putMediaRoomEscrow({scope:{tenantId:data.tenantID,userId:data.actorID,spaceId:data.spaceID,roomInstanceId:data.instanceID},credential:{expires_at:new Date(Date.now()+600000).toISOString(),can_subscribe:true,can_share_screen:true,can_publish_camera_microphone:false},choices:{audioEnabled:false,videoEnabled:false,visualEffects:prejoin.NO_VISUAL_EFFECTS},classTitle:"Lớp Toán"});',
      'const user={user:{id:data.actorID,display_name:data.actor},active_tenant:{id:data.tenantID,name:"TutorHub",role:data.role}};',
      'const content=h(router.MemoryRouter,{initialEntries:["/"+data.spaceID+"/"+data.instanceID]},h(router.Routes,null,h(router.Route,{path:"/:spaceId/:roomInstanceId",element:h(MediaSpaceRoomPage)})));',
      'createRoot(document.getElementById("root")).render(h(query.QueryClientProvider,{client:new query.QueryClient({defaultOptions:{queries:{retry:false}}})},h(I18nProvider,{initialLanguage:"vi"},h(SessionProvider,{mode:{kind:"static",currentUser:user}},content))));',
    ].join("\n");
    await route.fulfill({
      contentType: "text/html",
      body:
        '<!doctype html><html lang="vi"><head><title>Lớp Toán</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">' +
        bootstrap +
        "</script></body></html>",
    });
  });
  await page.goto(entry);
  await expect(
    page.locator("#media-p408-control-chat"),
    JSON.stringify(errors),
  ).toBeVisible();
  return { context, page, errors };
}
const pageField = (page: Page) =>
  page.locator(".classroom-files-topbar__page input");
const more = (page: Page) =>
  page.getByRole("button", { name: "Thêm tùy chọn" });
const exportName = "Xuất PDF học bài";
const notesButton = (page: Page) =>
  page.getByRole("button", { name: /^Ghi chú riêng/ });
const chatButton = (page: Page) => page.locator("#media-p408-control-chat");

async function openChat(page: Page) {
  if (!(await page.locator(".classroom-chat").isVisible()))
    await chatButton(page).click();
  await expect(page.locator(".classroom-chat")).toBeVisible();
}
async function action(page: Page, label: string | RegExp) {
  const direct = page.getByRole("button", { name: label, exact: true });
  if (await direct.isVisible()) return direct.click();
  await more(page).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}
async function noAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        details: n.failureSummary,
      })),
    })),
  ).toEqual([]);
}
async function markVideos(page: Page) {
  await expect(page.locator("video").first()).toBeAttached();
  await page.evaluate(() => {
    const captured = Array.from(document.querySelectorAll("video"));
    let removed = false;
    new MutationObserver((changes) => {
      for (const change of changes)
        for (const node of change.removedNodes)
          if (captured.some((video) => video === node || node.contains(video)))
            removed = true;
    }).observe(document.body, { childList: true, subtree: true });
    Object.assign(window, {
      videosIntact: () =>
        !removed && captured.every((node) => node.isConnected),
    });
  });
}
async function videosIntact(page: Page) {
  expect(
    await page.evaluate(() =>
      (window as unknown as { videosIntact(): boolean }).videosIntact(),
    ),
  ).toBe(true);
}
async function openNotes(page: Page) {
  await notesButton(page).click();
  const panel = page.getByRole("complementary", { name: "Ghi chú riêng" });
  await expect(panel.getByRole("textbox")).toBeFocused();
  return panel;
}
async function openExport(page: Page) {
  await action(page, exportName);
  return page.getByRole("dialog", { name: exportName });
}

test("Chat attachment, corrected vector worksheet, private notes and download policy across three classroom members", async ({
  browser,
}) => {
  const teacher = await mount(browser, "teacher");
  const student = await mount(browser, "alice");
  const other = await mount(browser, "bob");
  const t = teacher.page,
    s = student.page;
  try {
    await openChat(t);
    await openChat(s);
    await markVideos(t);
    await markVideos(s);
    await t
      .locator("input[type=file]")
      .last()
      .setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
    await t.getByRole("button", { name: "Gửi", exact: true }).click();
    await s.getByRole("button", { name: "Mở trong Tài liệu" }).click();
    await expect(s.locator('canvas[data-pdf-page="1"]')).toBeVisible();
    await expect(notesButton(s)).toHaveCount(0);
    await expect(
      s.getByRole("button", { name: "Lưu vào Kho tài liệu" }),
    ).toHaveCount(0);
    await t.getByRole("button", { name: "Lưu vào Kho tài liệu" }).click();
    await expect(t.locator('canvas[data-pdf-page="1"]')).toBeVisible();
    await t
      .getByRole("button", { name: "Trình chiếu cho lớp", exact: true })
      .click();
    await expect(
      s.getByRole("group", { name: "Trạng thái trình chiếu" }),
    ).toBeVisible({ timeout: 30000 });
    await expect(t.getByText("Đang kết nối nét chữa…")).toHaveCount(0);
    await pageField(t).fill("2");
    await pageField(t).press("Enter");
    await expect(pageField(s)).toHaveValue("2");
    const pen = t
      .getByRole("toolbar", { name: "Công cụ chú thích" })
      .getByRole("button", { name: "Bút viết", exact: true });
    await pen.click();
    const ink = t.locator('[data-pdf-ink-page="2"]');
    const box = (await ink.boundingBox())!;
    await t.mouse.move(box.x + box.width * 0.24, box.y + box.height * 0.22);
    await t.mouse.down();
    await t.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.33, {
      steps: 12,
    });
    await t.mouse.up();
    await expect(
      s.locator('[data-pdf-ink-page="2"] path[data-stroke-id]'),
    ).toHaveCount(1);
    await action(t, /Chia sẻ vào Trò chuyện.*2/);
    const composer = t.locator(".classroom-chat textarea");
    const block = await composer.inputValue();
    expect(block).toContain("tutorhub-doc");
    expect(block).not.toMatch(/https?:|storage|X-Amz-/i);
    await composer.fill("Xem lời chữa\n" + block);
    await t.getByRole("button", { name: "Gửi", exact: true }).click();
    // Prove that the card navigates: first move this student away from page 2.
    await pageField(s).fill("1");
    await pageField(s).press("Enter");
    await expect(pageField(s)).toHaveValue("1");
    await openChat(s);
    const card = s
      .locator("figure.classroom-chat__document")
      .filter({ hasText: "Trang 2" });
    await expect(
      s.locator(".classroom-chat").getByText("Xem lời chữa"),
    ).toBeVisible();
    await card.getByRole("button", { name: "Mở trong Tài liệu" }).click();
    await expect(pageField(s)).toHaveValue("2");
    const panel = await openNotes(s);
    await panel.getByRole("textbox").fill("Đổi dấu khi chuyển vế.");
    await expect(panel.getByRole("status")).toHaveText("Đã lưu");
    await noAxe(s);
    await s.setViewportSize({ width: 320, height: 640 });
    await s.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    expect(
      await s.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await noAxe(s);
    await panel.getByRole("textbox").press("Escape");
    await expect(notesButton(s)).toBeFocused();
    await s.setViewportSize({ width: 1440, height: 900 });
    await s.emulateMedia({ forcedColors: "none" });
    if (await more(s).isVisible()) await more(s).click();
    await expect(s.getByRole("menuitem", { name: exportName })).toHaveCount(0);
    await expect(s.getByRole("button", { name: exportName })).toHaveCount(0);
    await s.keyboard.press("Escape");
    await videosIntact(t);
    await videosIntact(s);
    await s.reload();
    await expect(pageField(s)).toHaveValue("2", { timeout: 30000 });
    await markVideos(s);
    const restored = await openNotes(s);
    await expect(restored.getByRole("textbox")).toHaveValue(
      "Đổi dấu khi chuyển vế.",
    );
    await restored.getByRole("textbox").press("Escape");
    for (const page of [t, other.page]) {
      const isolated = await openNotes(page);
      await expect(isolated.getByRole("status")).toHaveText("Đã lưu");
      await expect(isolated.getByRole("textbox")).toHaveValue("");
      await expect(isolated.getByText("Đổi dấu khi chuyển vế.")).toHaveCount(0);
      await isolated.getByRole("textbox").press("Escape");
    }
    let dialog = await openExport(t);
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(more(t)).toBeFocused();
    dialog = await openExport(t);
    const teacherDownload = t.waitForEvent("download");
    await dialog.getByRole("button", { name: "Tải PDF học bài" }).click();
    expect((await teacherDownload).suggestedFilename()).toBe(
      "Phieu-on-tap-hoc-bai.pdf",
    );
    await t.locator(".classroom-files-topbar__file").click();
    const downloadPolicy = t.getByRole("switch", { name: /HS tải/i });
    await downloadPolicy.click();
    await expect.poll(() => allowDownload).toBe(true);
    await expect(downloadPolicy).toBeChecked();
    await t.keyboard.press("Escape");
    // Opening the viewer menu picks up the teacher's updated download policy.
    dialog = await openExport(s);
    await expect(
      dialog.getByRole("checkbox", { name: /Kèm nét chữa/ }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: /Kèm ghi chú/ }),
    ).toBeChecked();
    await noAxe(s);
    await s.setViewportSize({ width: 320, height: 640 });
    await s.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await noAxe(s);
    const downloading = s.waitForEvent("download");
    await dialog.getByRole("button", { name: "Tải PDF học bài" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("Phieu-on-tap-hoc-bai.pdf");
    const buffer = await readFile((await download.path())!);
    expect(buffer.subarray(0, bytes.length).equals(bytes)).toBe(true);
    // This worksheet's original pages contain only text. The appended PDF
    // path must therefore be the correction drawn on the teacher's page.
    expect(buffer.subarray(bytes.length).toString("latin1")).toMatch(
      /[-\d.]+ [-\d.]+ m\n(?:[-\d.]+ [-\d.]+ l\n)+S\n/u,
    );
    const reopened = await s.evaluate(async (data) => {
      const runtimePath = "/src/features/classroom-tools/pdfRuntime.ts";
      const { openPdfDocument } = await import(runtimePath);
      const task = openPdfDocument(Uint8Array.from(data));
      const pdf = await task.promise;
      try {
        const text = await (await pdf.getPage(2)).getTextContent();
        return {
          count: pdf.numPages,
          text: text.items.map((item: { str?: string }) => item.str).join(" "),
        };
      } finally {
        await task.destroy();
      }
    }, Array.from(buffer));
    expect(reopened).toEqual({ count: 3, text: "Equation 2" });
    await videosIntact(s);
    await videosIntact(t);
    expect([...teacher.errors, ...student.errors, ...other.errors]).toEqual([]);
  } finally {
    await Promise.all(
      [teacher, student, other].map(({ context }) => context.close()),
    );
  }
});
