import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const userID = "1d7d65eb-904e-4a0d-bd24-a8ec1b453d64";
const spaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const sessionID = "8477ee76-c4aa-431f-bb65-405f4b6575c9";
const roomInstanceID = "c5f918a5-a09e-4f94-9fab-fb0ab5702a4d";
const participantSessionID = "f680fd29-c7f1-4083-af9b-52ad1db14ba9";
const joinAttemptID = "a860f06d-34f9-4c57-89f8-1541bfb3b6d7";
const admissionRequestID = "d48a301d-c468-4f65-8da2-029fc379ee74";
const credentialToken = "p4-03-memory-only-livekit-token";

const prejoinPath = `/app/media/spaces/${spaceID}/prejoin`;
const roomPath = `/app/media/spaces/${spaceID}/instances/${roomInstanceID}/room`;

const currentUser = {
  user: {
    id: userID,
    email: "student@example.test",
    display_name: "Student One",
    locale: "en",
    timezone: "Asia/Ho_Chi_Minh",
  },
  active_tenant: {
    id: tenantID,
    slug: "tutorhub-test",
    name: "TutorHub Test",
    role: "student",
    is_active: true,
    status: "active",
    version: 1,
  },
  memberships: [],
  permissions: ["session.join"],
};

const mediaSpace = {
  id: spaceID,
  source: { kind: "class_session", class_session_id: sessionID },
  status: "open",
  version: 4,
  active_room_instance: {
    id: roomInstanceID,
    status: "active",
    version: 2,
    created_at: "2030-08-03T00:00:00Z",
    updated_at: "2030-08-03T00:01:00Z",
  },
  viewer_operations: {
    can_start: false,
    can_end: false,
    can_cancel: false,
  },
  created_at: "2030-08-03T00:00:00Z",
  updated_at: "2030-08-03T00:01:00Z",
};

interface ObservedRequests {
  attemptBodies: unknown[];
  credentialBodies: unknown[];
  healthCalls: number;
  order: string[];
  profileBodies: unknown[];
}

interface MediaProbeState {
  enumerateDevicesCalls: number;
  getUserMediaCalls: number;
  stoppedTracks: number;
}

function tenantCapabilities() {
  return {
    tenant_id: tenantID,
    version: 1,
    can_manage_overrides: false,
    features: {
      in_app_notifications: {
        configured_enabled: false,
        enabled: false,
      },
    },
    quotas: {},
    operations: {},
  };
}

async function fulfillJSON(route: Route, status: number, body: unknown) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
    status,
  });
}

async function installMediaProbe(page: Page) {
  await page.addInitScript(() => {
    const state: MediaProbeState = {
      enumerateDevicesCalls: 0,
      getUserMediaCalls: 0,
      stoppedTracks: 0,
    };
    const events = new EventTarget();
    const track = (kind: "audio" | "video", deviceId: string) => ({
      contentHint: "",
      getSettings: () =>
        kind === "audio"
          ? {
              autoGainControl: true,
              deviceId,
              echoCancellation: true,
              noiseSuppression: true,
            }
          : { deviceId },
      kind,
      stop: () => {
        state.stoppedTracks += 1;
      },
    });
    const audioTrack = track("audio", "microphone-1");
    const videoTrack = track("video", "camera-1");
    const stream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack, videoTrack],
      getVideoTracks: () => [videoTrack],
    };
    const device = (
      kind: MediaDeviceKind,
      deviceId: string,
      label: string,
    ) => ({
      deviceId,
      groupId: `${deviceId}-group`,
      kind,
      label,
      toJSON: () => ({ deviceId, kind, label }),
    });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: events.addEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        enumerateDevices: async () => {
          state.enumerateDevicesCalls += 1;
          return [
            device("audioinput", "microphone-1", "Class microphone"),
            device("videoinput", "camera-1", "Class camera"),
            device("audiooutput", "speaker-1", "Class speaker"),
          ];
        },
        getSupportedConstraints: () => ({
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        }),
        getUserMedia: async () => {
          state.getUserMediaCalls += 1;
          return stream;
        },
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() {
        return (this as HTMLMediaElement & { __p403Source?: unknown })
          .__p403Source;
      },
      set(value: unknown) {
        (this as HTMLMediaElement & { __p403Source?: unknown }).__p403Source =
          value;
      },
    });
    HTMLMediaElement.prototype.play = async () => undefined;
    HTMLMediaElement.prototype.pause = () => undefined;
    (
      window as unknown as { __p403MediaProbe: MediaProbeState }
    ).__p403MediaProbe = state;
  });
}

async function readMediaProbe(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __p403MediaProbe: MediaProbeState })
        .__p403MediaProbe,
  );
}

async function installDeniedMediaProbe(page: Page) {
  await page.addInitScript(() => {
    const state: MediaProbeState = {
      enumerateDevicesCalls: 0,
      getUserMediaCalls: 0,
      stoppedTracks: 0,
    };
    const events = new EventTarget();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: events.addEventListener.bind(events),
        enumerateDevices: async () => {
          state.enumerateDevicesCalls += 1;
          return [];
        },
        getSupportedConstraints: () => ({}),
        getUserMedia: async () => {
          state.getUserMediaCalls += 1;
          throw new DOMException("fixture detail", "NotAllowedError");
        },
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
    (
      window as unknown as { __p403MediaProbe: MediaProbeState }
    ).__p403MediaProbe = state;
  });
}

async function installOfflineState(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
  });
}

async function installApiMocks(page: Page, admission: "waiting" | "admitted") {
  const observed: ObservedRequests = {
    attemptBodies: [],
    credentialBodies: [],
    healthCalls: 0,
    order: [],
    profileBodies: [],
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());

    if (request.method() === "GET" && pathname === "/api/health") {
      observed.healthCalls += 1;
      await fulfillJSON(route, 200, { status: "ok" });
      return;
    }
    if (request.method() === "GET" && pathname === "/api/v1/me") {
      await fulfillJSON(route, 200, currentUser);
      return;
    }
    if (
      request.method() === "GET" &&
      pathname === `/api/v1/tenants/${tenantID}/capabilities`
    ) {
      await fulfillJSON(route, 200, tenantCapabilities());
      return;
    }
    if (
      request.method() === "GET" &&
      pathname === `/api/v1/media/spaces/${spaceID}`
    ) {
      await fulfillJSON(route, 200, mediaSpace);
      return;
    }
    if (request.method() === "PATCH" && pathname === "/api/v1/me/profile") {
      observed.order.push("profile");
      const body = request.postDataJSON() as { display_name: string };
      observed.profileBodies.push(body);
      await fulfillJSON(route, 200, {
        user: { ...currentUser.user, display_name: body.display_name },
      });
      return;
    }
    if (request.method() === "GET" && pathname === "/api/v1/auth/csrf") {
      observed.order.push("csrf");
      await fulfillJSON(route, 200, { csrf_token: "p4-03-csrf" });
      return;
    }
    if (
      request.method() === "POST" &&
      pathname === `/api/v1/media/spaces/${spaceID}/join-attempts`
    ) {
      observed.order.push("attempt");
      observed.attemptBodies.push(request.postDataJSON());
      await fulfillJSON(route, 201, {
        admission_request_id:
          admission === "waiting" ? admissionRequestID : null,
        can_publish_camera_microphone: true,
        can_share_screen: false,
        can_subscribe: true,
        created_at: "2030-08-03T00:02:00Z",
        instance_role: "attendee",
        join_attempt_id: joinAttemptID,
        participant_session_id: participantSessionID,
        room_instance_id: roomInstanceID,
        status: admission,
        updated_at: "2030-08-03T00:02:00Z",
        version: 1,
      });
      return;
    }
    if (
      request.method() === "POST" &&
      pathname === `/api/v1/media/spaces/${spaceID}/join-credentials`
    ) {
      observed.order.push("credential");
      observed.credentialBodies.push(request.postDataJSON());
      await fulfillJSON(route, 200, {
        access_token: credentialToken,
        can_publish_camera_microphone: true,
        can_share_screen: false,
        can_subscribe: true,
        expires_at: "2030-08-03T00:05:00Z",
        instance_role: "attendee",
        join_attempt_id: joinAttemptID,
        participant_session_id: participantSessionID,
        room_instance_id: roomInstanceID,
        server_url: "wss://media.example.test",
      });
      return;
    }

    await fulfillJSON(route, 404, {
      detail: `No P4-03 fixture for ${request.method()} ${pathname}`,
      status: 404,
      title: "Fixture not found",
      type: "urn:tutorhub:problem:not-found",
    });
  });

  return observed;
}

async function openEnglishPrejoin(page: Page) {
  await page.goto(prejoinPath);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /^(?:Vào phòng học|Enter Meeting)$/,
    }),
  ).toBeVisible();
  const language = page.locator(".language-select select");
  await language.selectOption("en");
  await expect(
    page.getByRole("heading", { level: 1, name: "Enter Meeting" }),
  ).toBeVisible();
}

/** Joins without opening a device: nothing was enabled in the preview. */
async function joinWithoutDevices(page: Page) {
  await page.getByRole("button", { name: "Join", exact: true }).click();
}

function allowButton(page: Page) {
  return page.getByRole("button", { name: "Allow microphone and camera" });
}

function deviceButton(page: Page, name: "Microphone" | "Camera") {
  return page.getByRole("button", { name, exact: true });
}

test.beforeEach(async ({ page }) => {
  await installMediaProbe(page);
});

test("P4-03 keeps initial capture at zero and starts a keyboard-accessible explicit probe", async ({
  page,
}) => {
  const observed = await installApiMocks(page, "admitted");
  await openEnglishPrejoin(page);

  expect(await readMediaProbe(page)).toEqual({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
    stoppedTracks: 0,
  });
  expect(observed.order).toEqual([]);

  const probe = allowButton(page);
  await probe.focus();
  await expect(probe).toBeFocused();
  await probe.press("Enter");

  await expect
    .poll(async () => readMediaProbe(page))
    .toMatchObject({ enumerateDevicesCalls: 1, getUserMediaCalls: 1 });
  await expect(page.getByRole("combobox", { name: "Microphone" })).toHaveValue(
    "microphone-1",
  );
  await expect(page.getByRole("combobox", { name: "Camera" })).toHaveValue(
    "camera-1",
  );
  // The Allow button leaves the frame; focus moves to the camera button.
  await expect(probe).toHaveCount(0);
  await expect(deviceButton(page, "Camera")).toBeFocused();
  await expect(deviceButton(page, "Camera")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(deviceButton(page, "Microphone")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(observed.order).toEqual([]);
  expect(
    (await new AxeBuilder({ page }).include(".media-p403-page").analyze())
      .violations,
  ).toEqual([]);
});

test("P4-03 a device-free waiting request never captures, requests a credential, or navigates", async ({
  page,
}) => {
  const observed = await installApiMocks(page, "waiting");
  await openEnglishPrejoin(page);

  await joinWithoutDevices(page);

  await expect(
    page.getByRole("heading", { name: "Waiting to be admitted" }),
  ).toBeVisible();
  expect(observed.order).toEqual(["csrf", "attempt"]);
  expect(observed.attemptBodies).toEqual([
    {
      expected_room_instance_id: roomInstanceID,
      expected_space_version: mediaSpace.version,
      join_attempt_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    },
  ]);
  expect(observed.credentialBodies).toEqual([]);
  expect(await readMediaProbe(page)).toMatchObject({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
  });
  await expect(page).toHaveURL(new RegExp(`${prejoinPath}$`));
});

test("P4-03 requests an admitted attempt before a memory-only credential handoff", async ({
  page,
}) => {
  const observed = await installApiMocks(page, "admitted");
  await openEnglishPrejoin(page);

  await joinWithoutDevices(page);

  await expect(page).toHaveURL(new RegExp(`${roomPath}$`));
  expect(observed.order).toEqual(["csrf", "attempt", "credential"]);
  expect(observed.credentialBodies).toEqual([
    { join_attempt_id: joinAttemptID },
  ]);
  expect(await readMediaProbe(page)).toMatchObject({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
  });

  const privacySurfaces = await page.evaluate(() => ({
    history: JSON.stringify(window.history.state ?? null),
    localStorage: Object.values(window.localStorage),
    sessionStorage: Object.values(window.sessionStorage),
    url: window.location.href,
  }));
  expect(privacySurfaces.url).not.toContain(credentialToken);
  expect(privacySurfaces.history).not.toContain(credentialToken);
  expect(privacySurfaces.localStorage).not.toContain(credentialToken);
  expect(privacySurfaces.sessionStorage).not.toContain(credentialToken);
});

test("P4-03 permission denial remains bounded and still allows a device-free join", async ({
  page,
}) => {
  await installDeniedMediaProbe(page);
  const observed = await installApiMocks(page, "waiting");
  await openEnglishPrejoin(page);

  await allowButton(page).click();
  await expect(
    page.getByText(
      "Camera or microphone permission was denied. You can still join without them.",
    ),
  ).toBeVisible();
  // The invitation stays in the frame so the viewer can try again.
  await expect(allowButton(page)).toBeVisible();
  expect(await readMediaProbe(page)).toMatchObject({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 1,
    stoppedTracks: 0,
  });

  await joinWithoutDevices(page);
  await expect(
    page.getByRole("heading", { name: "Waiting to be admitted" }),
  ).toBeVisible();
  expect(observed.order).toEqual(["csrf", "attempt"]);
  expect(observed.credentialBodies).toEqual([]);
  await expect(page).toHaveURL(new RegExp(`${prejoinPath}$`));
});

test("P4-03 reports offline without probing health or opening media", async ({
  page,
}) => {
  await installOfflineState(page);
  const observed = await installApiMocks(page, "admitted");
  await page.goto(prejoinPath);

  await expect(
    page.getByRole("heading", { level: 1, name: /ngoại tuyến|offline/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Thử lại|Retry/ }),
  ).toBeVisible();
  expect(observed.healthCalls).toBe(0);
  expect(observed.order).toEqual([]);
  expect(await readMediaProbe(page)).toEqual({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
    stoppedTracks: 0,
  });
});

test("PREJOIN-CLONE-04 saves a remembered, edited name before the attempt and never renders the email", async ({
  page,
}) => {
  const observed = await installApiMocks(page, "waiting");
  await openEnglishPrejoin(page);
  await expect(page.locator("body")).not.toContainText("student@example.test");

  const name = page.getByRole("textbox", { name: "Your Name" });
  await expect(name).toHaveValue("Student One");
  await expect(
    page.getByRole("checkbox", {
      name: "Remember my name for future meetings",
    }),
  ).toBeChecked();
  await name.fill("  Lan Anh  ");
  // The frame label follows the field.
  await expect(page.locator(".media-p403-preview__name")).toHaveText("Lan Anh");
  await joinWithoutDevices(page);

  await expect(
    page.getByRole("heading", { name: "Waiting to be admitted" }),
  ).toBeVisible();
  // csrf → PATCH /api/v1/me/profile → attempt; an unchanged name skips the
  // profile step (see the admitted handoff test above).
  expect(observed.order).toEqual(["csrf", "profile", "attempt"]);
  expect(observed.profileBodies).toEqual([{ display_name: "Lan Anh" }]);
  expect(observed.credentialBodies).toEqual([]);
  expect(await readMediaProbe(page)).toMatchObject({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
  });
  await expect(page.locator("body")).not.toContainText("student@example.test");
});

test("PREJOIN-CLONE-04 skips the profile request when the name is not remembered or is cleared", async ({
  page,
}) => {
  const observed = await installApiMocks(page, "waiting");
  await openEnglishPrejoin(page);

  // A cleared field joins with the account name and shows no extra error.
  const name = page.getByRole("textbox", { name: "Your Name" });
  await name.fill("   ");
  await expect(page.locator(".media-p403-preview__name")).toHaveText(
    "Student One",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);

  // An edited name that is not remembered is not saved either.
  await name.fill("Lan Anh");
  await page
    .getByRole("checkbox", { name: "Remember my name for future meetings" })
    .uncheck();
  await joinWithoutDevices(page);

  await expect(
    page.getByRole("heading", { name: "Waiting to be admitted" }),
  ).toBeVisible();
  expect(observed.order).toEqual(["csrf", "attempt"]);
  expect(observed.profileBodies).toEqual([]);
});

test("PREJOIN-CLONE-04 opens the terms dialog from the agreement line and restores focus", async ({
  page,
}) => {
  const observed = await installApiMocks(page, "admitted");
  await openEnglishPrejoin(page);

  const terms = page.getByRole("button", { name: "Terms of Service" });
  await terms.click();
  const dialog = page.getByRole("dialog", { name: "Terms & Privacy Policy" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("tab", { name: "User Agreement" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(terms).toBeFocused();

  await page.getByRole("button", { name: "Privacy Statement" }).click();
  await expect(
    dialog.getByRole("tab", { name: "Privacy Policy" }),
  ).toHaveAttribute("aria-selected", "true");
  expect(observed.order).toEqual([]);
  expect(await readMediaProbe(page)).toMatchObject({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
  });
});

async function readPageOverflow(page: Page) {
  return page.evaluate(() => ({
    horizontal:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
    vertical:
      document.documentElement.scrollHeight -
      document.documentElement.clientHeight,
  }));
}

// PREJOIN-SCALE-05: the frame grows with the viewport width and the height
// left for a 16:9 frame, and the page never scrolls at these sizes.
for (const { minPreviewWidth, ...viewport } of [
  { width: 1280, height: 800, minPreviewWidth: 760 },
  { width: 1440, height: 900, minPreviewWidth: 890 },
  { width: 1536, height: 750, minPreviewWidth: 950 },
  { width: 1920, height: 1080, minPreviewWidth: 1060 },
]) {
  test(`PREJOIN-SCALE-05 keeps a large 16:9 frame, three round buttons, four pills and the centred Enter Meeting form in one viewport at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const observed = await installApiMocks(page, "admitted");
    await page.goto(prejoinPath);

    // Vietnamese first: the longer copy must not overflow either.
    const language = page.locator(".language-select select");
    await expect(language).toBeVisible();
    await language.selectOption("vi");
    await expect(
      page.getByRole("heading", { level: 1, name: "Vào phòng học" }),
    ).toBeVisible();
    const vietnameseOverflow = await readPageOverflow(page);
    expect(vietnameseOverflow.horizontal).toBeLessThanOrEqual(1);
    expect(vietnameseOverflow.vertical).toBeLessThanOrEqual(1);
    const vietnameseFrame = await page
      .locator(".media-p403-preview")
      .boundingBox();
    const vietnameseTerms = await page
      .locator(".media-p403-form__terms")
      .boundingBox();
    expect(vietnameseTerms!.y + vietnameseTerms!.height).toBeLessThanOrEqual(
      vietnameseFrame!.y + vietnameseFrame!.height,
    );

    await language.selectOption("en");
    await expect(
      page.getByRole("heading", { level: 1, name: "Enter Meeting" }),
    ).toBeVisible();

    // Focused studio: thin header, no AppShell sidebar navigation, no footer.
    await expect(page.locator(".app-sidebar")).toHaveCount(0);
    await expect(page.getByRole("contentinfo")).toHaveCount(0);
    const banner = page.getByRole("banner");
    await expect(banner).toContainText("TutorHub Test");
    await expect(
      banner.getByRole("link", { name: "← Back to Home" }),
    ).toBeVisible();
    await expect(banner.locator(".language-select select")).toBeVisible();
    const headerBox = await banner.boundingBox();
    expect(headerBox?.height ?? 0).toBeGreaterThanOrEqual(48);
    expect(headerBox?.height ?? 0).toBeLessThanOrEqual(56);

    const preview = await page.locator(".media-p403-preview").boundingBox();
    expect(preview).not.toBeNull();
    expect(Math.abs(preview!.width / preview!.height - 16 / 9)).toBeLessThan(
      0.02,
    );
    expect(preview!.width).toBeGreaterThanOrEqual(minPreviewWidth);

    // Three separate 52px circles inside the frame's bottom edge.
    const circles = page.locator(".media-p403-preview .media-p403-round");
    await expect(circles).toHaveCount(3);
    for (const circle of await circles.all()) {
      const box = await circle.boundingBox();
      expect(Math.round(box!.width)).toBe(52);
      expect(Math.round(box!.height)).toBe(52);
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        preview!.y + preview!.height,
      );
    }

    // Four equal 36px pills directly under the frame, spanning its width.
    const pills = page.locator(".media-p403-pill");
    await expect(pills).toHaveCount(4);
    const pillBoxes = await Promise.all(
      (await pills.all()).map((pill) => pill.boundingBox()),
    );
    for (const box of pillBoxes) {
      expect(Math.round(box!.height)).toBe(36);
      expect(Math.abs(box!.width - pillBoxes[0]!.width)).toBeLessThanOrEqual(1);
      expect(box!.y).toBeGreaterThan(preview!.y + preview!.height);
    }
    expect(Math.abs(pillBoxes[0]!.x - preview!.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        pillBoxes[3]!.x + pillBoxes[3]!.width - (preview!.x + preview!.width),
      ),
    ).toBeLessThanOrEqual(1);
    for (const pill of await page.locator(".media-p403-pill select").all()) {
      await expect(pill).toBeDisabled();
      await expect(pill).toHaveText("Permission needed");
    }

    // The form column sits right of the frame, within its height, on the
    // frame's optical centre (no empty block under a top-pinned form).
    const title = await page
      .getByRole("heading", { level: 1, name: "Enter Meeting" })
      .boundingBox();
    const terms = await page.locator(".media-p403-form__terms").boundingBox();
    const form = await page.locator(".media-p403-form").boundingBox();
    expect(title!.x).toBeGreaterThan(preview!.x + preview!.width);
    expect(title!.y).toBeGreaterThanOrEqual(preview!.y);
    expect(terms!.y + terms!.height).toBeLessThanOrEqual(
      preview!.y + preview!.height,
    );
    expect(
      Math.abs(form!.y + form!.height / 2 - (preview!.y + preview!.height / 2)),
    ).toBeLessThanOrEqual(2);

    for (const control of [
      page.getByRole("button", { name: "More options" }),
      allowButton(page),
      deviceButton(page, "Microphone"),
      deviceButton(page, "Camera"),
      page.getByRole("button", { name: "Backgrounds and effects" }),
      page.getByRole("combobox", { name: "Speaker" }),
      page.getByRole("combobox", { name: "Audio mode" }),
      page.getByRole("textbox", { name: "Your Name" }),
      page.getByRole("checkbox", {
        name: "Remember my name for future meetings",
      }),
      page.getByRole("button", { name: "Join", exact: true }),
      page.getByRole("button", { name: "Terms of Service" }),
      page.getByRole("button", { name: "Privacy Statement" }),
    ]) {
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    // Nothing from earlier, wordier drafts.
    for (const removed of [
      "Join now",
      "Join listen-only",
      "Don't use audio",
      "Connection diagnostics (24h)",
      "Live session open",
      "You'll join with",
    ]) {
      await expect(page.getByText(removed)).toHaveCount(0);
    }
    const overflow = await readPageOverflow(page);
    expect(overflow.horizontal).toBeLessThanOrEqual(1);
    expect(overflow.vertical).toBeLessThanOrEqual(1);
    expect(await readMediaProbe(page)).toEqual({
      enumerateDevicesCalls: 0,
      getUserMediaCalls: 0,
      stoppedTracks: 0,
    });
    expect(observed.order).toEqual([]);
    expect(
      (await new AxeBuilder({ page }).include(".media-p403-page").analyze())
        .violations,
    ).toEqual([]);
  });
}

test("P4-03 keeps keyboard actions and reflow at forced colors and 320 CSS pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await installApiMocks(page, "admitted");
  await openEnglishPrejoin(page);

  const probe = allowButton(page);
  const join = page.getByRole("button", { name: "Join", exact: true });
  await expect(probe).toBeVisible();
  await expect(join).toBeVisible();
  await probe.focus();
  await expect(probe).toBeFocused();
  const cameraButton = deviceButton(page, "Camera");
  await cameraButton.focus();
  await expect(cameraButton).toBeFocused();
  await join.focus();
  await expect(join).toBeFocused();
  const headerBox = await page.getByRole("banner").boundingBox();
  expect(headerBox?.height ?? 0).toBeLessThanOrEqual(56);
  const horizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
  expect(
    (await new AxeBuilder({ page }).include(".media-p403-page").analyze())
      .violations,
  ).toEqual([]);
  // Focusing the controls never opens a device.
  expect(await readMediaProbe(page)).toEqual({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
    stoppedTracks: 0,
  });
});

test("PREJOIN-CLONE-04 reports zero Axe violations at forced colors on desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ forcedColors: "active" });
  await installApiMocks(page, "admitted");
  await openEnglishPrejoin(page);

  await allowButton(page).click();
  await expect(deviceButton(page, "Microphone")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    (await new AxeBuilder({ page }).include(".media-p403-page").analyze())
      .violations,
  ).toEqual([]);
});

// VIDEO-FX-01 (ADR-0041): Google Meet-style effects studio on Pre-Join.
// Set VIDEO_FX_SCREENSHOT_DIR to save a reference screenshot for review.
const fxScreenshotDir = process.env.VIDEO_FX_SCREENSHOT_DIR?.trim() ?? "";

// 32x18 opaque PNG: real image bytes for the device-local upload path.
const tinyPNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAIAAAC1qksFAAADx0lEQVR4nBWUEbbFMABEu5zKk0rlSaVSqVQqlSeVSuRKJBKJRCKRSCQSiUQikS7rnz8bmDNn5s4w8n54J96Z98u78K68G+/Oe/CevBfvj/fmfXgFL7ySV/FqXsNreR2v5w28kTfxZt7CW3kbb+cdRvqHPtFn+pe+0Ff6Rt/pB/2kX/Qf/aY/dEGHLumKrumGbumO7umBHumJnumFXumN3unDSPvQJtpM+9IW2krbaDvtoJ20i/aj3bSHJmjQJE3RNM3QLM3RPC3QIi3RMq3QKq3ROm0YqR/qRJ2pX+pCXakbdace1JN6UX/Um/pQBRWqpCqqphqqpTqqpwZqpCZqphZqpTZqpw4j5UOZKDPlS1koK2Wj7JSDclIuyo9yUx6KoECRFEXRFEOxFEfxlECJlETJlEKplEbplGEkf8gTeSZ/yQt5JW/knXyQT/JF/pFv8kMWZMiSrMiabMiW7MieHMiRnMiZXMiV3MidPIykD2kizaQvaSGtpI20kw7SSbpIP9JNekiCBEmSFEmTDMmSHMmTAimSEimTCqmSGqmThpH4IU7EmfglLsSVuBF34kE8iRfxR7yJD1EQIUqiImqiIVqiI3piIEZiImZiIVZiI3biMBI+hIkwE76EhbASNsJOOAgn4SL8CDfhIQgCBElQBE0wBEtwBE8IhEhIhEwohEpohE4YRvwHP+Fn/Be/4Ff8ht/xB/7EX/gf/sY/eIEHL/EKr/EGb/EO7/EBH/EJn/EFX/EN3/HDiPvgJtyM++IW3IrbcDvuwJ24C/fD3bgHJ3DgJE7hNM7gLM7hPC7gIi7hMq7gKq7hOm4YsR/shJ2xX+yCXbEbdsce2BN7YX/YG/tgBRasxCqsxhqsxTqsxwZsxCZsxhZsxTZsxw4j5oOZMDPmi1kwK2bD7JgDc2IuzA9zYx6MwICRGIXRGIOxGIfxmICJmITJmIKpmIbpmGFEf9ATekZ/0Qt6RW/oHX2gT/SF/qFv9IMWaNASrdAabdAW7dAeHdARndAZXdAV3dAdPYyoD2pCzagvakGtqA21ow7UibpQP9SNelACBUqiFEqjDMqiHMqjAiqiEiqjCqqiGqqjhhH5QU7IGflFLsgVuSF35IE8kRfyh7yRD1IgQUqkQmqkQVqkQ3pkQEZkQmZkQVZkQ3bkMMIHJpjhCwussMEOB5xwwQ9ueEDwL8l/EM1/IZb/YXn+AYn8g575P6zK//F2GEbEBzEhZsQXsSBWxIbYEQfiRFyIH+JGPAjxbyEkQiE0wiAswiE8IiAiIiEyoiAqoiE64g+q1HjuXVQAyAAAAABJRU5ErkJggg==",
  "base64",
);

test("VIDEO-FX-01 opens the effects studio, records a background without capturing and passes Axe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const observed = await installApiMocks(page, "admitted");
  await openEnglishPrejoin(page);

  const trigger = page.getByRole("button", { name: "Backgrounds and effects" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const studio = page.getByRole("dialog", { name: "Backgrounds and effects" });
  await expect(studio).toBeVisible();

  // Two columns: the 16:9 preview on the left, the picker on the right.
  const studioBox = await studio.boundingBox();
  expect(studioBox!.width).toBeLessThanOrEqual(1080);
  expect(
    await studio.evaluate((element) => getComputedStyle(element).borderRadius),
  ).toBe("24px");
  const preview = await studio.locator(".media-p403-fx-preview").boundingBox();
  const side = await studio.locator(".media-p403-fx-side").boundingBox();
  expect(Math.abs(preview!.width / preview!.height - 16 / 9)).toBeLessThan(
    0.02,
  );
  expect(side!.x).toBeGreaterThan(preview!.x + preview!.width);
  expect(preview!.width / (preview!.width + side!.width)).toBeGreaterThan(0.55);
  await expect(
    studio.getByRole("button", { name: "Turn on camera to preview" }),
  ).toBeVisible();

  const library = studio.getByRole("button", { name: "Library" });
  await library.click();
  await expect(library).toHaveAttribute("aria-pressed", "true");
  await expect(
    studio.getByRole("button", { name: "Turn off all effects" }),
  ).toBeVisible();

  // A personal image is decoded, re-encoded and kept on this device only.
  await studio.getByTestId("vfx-upload-input").setInputFiles({
    name: "classroom.png",
    mimeType: "image/png",
    buffer: tinyPNG,
  });
  const personal = studio.getByRole("button", {
    name: "Your image 1",
    exact: true,
  });
  await expect(personal).toHaveAttribute("aria-pressed", "true");
  await studio.getByRole("button", { name: "Remove your image 1" }).click();
  await expect(personal).toHaveCount(0);
  await expect(studio.getByRole("button", { name: "None" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await library.click();

  await studio.getByRole("tab", { name: "Lighting" }).click();
  await studio.getByText("Low-light boost").click();
  await expect(
    studio.getByRole("radio", { name: "Low-light boost" }),
  ).toBeChecked();
  await studio.getByRole("tab", { name: "Backgrounds" }).click();

  expect(await readMediaProbe(page)).toEqual({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
    stoppedTracks: 0,
  });
  expect(observed.order).toEqual([]);
  expect(
    (await new AxeBuilder({ page }).include(".media-p403-fx-dialog").analyze())
      .violations,
  ).toEqual([]);
  if (fxScreenshotDir) {
    await page.screenshot({
      path: `${fxScreenshotDir}/prejoin-effects-modal.png`,
    });
  }

  await page.keyboard.press("Escape");
  await expect(studio).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveClass(/media-p403-round--effects-on/);

  // Only the explicit preview button opens the camera, and only the camera.
  await trigger.click();
  await studio
    .getByRole("button", { name: "Turn on camera to preview" })
    .click();
  await expect
    .poll(async () => readMediaProbe(page))
    .toMatchObject({ getUserMediaCalls: 1 });
  await expect(
    studio.getByRole("button", { name: "Turn on camera to preview" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(studio).toHaveCount(0);
  await expect(deviceButton(page, "Camera")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(deviceButton(page, "Microphone")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("VIDEO-FX-01 keeps the effects studio usable at 320 CSS pixels with forced colors", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await installApiMocks(page, "admitted");
  await openEnglishPrejoin(page);

  await page.getByRole("button", { name: "Backgrounds and effects" }).click();
  const studio = page.getByRole("dialog", { name: "Backgrounds and effects" });
  await expect(studio).toBeVisible();
  await studio.getByRole("button", { name: "Strong blur" }).click();
  await expect(
    studio.getByRole("button", { name: "Strong blur" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    (await new AxeBuilder({ page }).include(".media-p403-fx-dialog").analyze())
      .violations,
  ).toEqual([]);
  expect(await readMediaProbe(page)).toEqual({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
    stoppedTracks: 0,
  });
});
