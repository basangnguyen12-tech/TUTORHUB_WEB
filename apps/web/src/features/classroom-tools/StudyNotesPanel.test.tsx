// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  APIRequestError,
  getRoomStudyNote,
  putRoomStudyNote,
  rotateCSRFToken,
  type RoomStudyNote,
  type StudyNoteEntry,
} from "@tutorhub/api-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import { useRoomStudyNotes } from "../../app/roomStudyNotes";
import { StudyNotesPanel } from "./StudyNotesPanel";
import { createClassroomFilesSession } from "./filesSession";

vi.mock("@tutorhub/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tutorhub/api-client")>()),
  getRoomStudyNote: vi.fn(),
  putRoomStudyNote: vi.fn(),
  rotateCSRFToken: vi.fn(),
}));
const record = (
  version: number,
  entries: readonly StudyNoteEntry[] = [],
): RoomStudyNote => ({
  byte_length: 0,
  entries,
  expires_at: null,
  file_id: "file",
  updated_at: null,
  version,
});
const onClose = vi.fn();
const onPage = vi.fn();
const onKeyDown = vi.fn();
let session: ReturnType<typeof createClassroomFilesSession>;
function Editor({ page = 1, open = true }: { page?: number; open?: boolean }) {
  const notes = useRoomStudyNotes("tenant", "space", "file", "actor", session);
  return (
    <I18nProvider initialLanguage="vi">
      <div onKeyDown={onKeyDown}>
        {open && (
          <StudyNotesPanel
            notes={notes}
            page={page}
            onClose={onClose}
            onPage={onPage}
            id="notes"
          />
        )}
      </div>
    </I18nProvider>
  );
}
beforeEach(() => {
  session = createClassroomFilesSession();
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(getRoomStudyNote).mockResolvedValue(record(3));
  vi.mocked(rotateCSRFToken).mockResolvedValue({ csrf_token: "csrf" });
  vi.mocked(putRoomStudyNote).mockImplementation(
    async (_tenant, _space, _file, request) =>
      record(request.expected_version + 1, request.entries),
  );
});
afterEach(() => {
  cleanup();
  session.clear();
  vi.useRealTimers();
});
it("flushes a closing viewer and recovers a conflicting draft on returning to the room tool", async () => {
  vi.mocked(putRoomStudyNote).mockRejectedValueOnce(
    conflict("room_document_version_conflict"),
  );
  const view = render(<Editor />);
  await tick();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Bản nháp" },
  });
  view.unmount();
  await tick();
  expect(putRoomStudyNote).toHaveBeenCalledOnce();
  const reopened = render(<Editor />);
  expect(screen.getByRole("textbox")).toHaveValue("Bản nháp");
  expect(screen.getByRole("alert")).toBeVisible();
  reopened.unmount();
  session.clear();
  render(<Editor />);
  await tick();
  expect(screen.getByRole("textbox")).toHaveValue("");
});
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
it("debounces writes, flushes on page change and drawer close, and keeps keyboard navigation inside the textarea", async () => {
  const view = render(<Editor />);
  await tick();
  const input = screen.getByRole("textbox");
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "Nháp" } });
  await tick(799);
  expect(putRoomStudyNote).not.toHaveBeenCalled();
  await tick(1);
  expect(putRoomStudyNote).toHaveBeenCalledWith(
    "tenant",
    "space",
    "file",
    { entries: [{ page: 1, text: "Nháp" }], expected_version: 3 },
    "csrf",
    expect.anything(),
  );
  fireEvent.keyDown(input, { key: "PageDown" });
  expect(onKeyDown).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { value: "Một" } });
  view.rerender(<Editor page={2} />);
  await tick();
  expect(vi.mocked(putRoomStudyNote).mock.lastCall?.[3].expected_version).toBe(
    4,
  );
  fireEvent.change(input, { target: { value: "Hai" } });
  fireEvent.click(screen.getByRole("button", { name: /Trang 1/ }));
  expect(onPage).toHaveBeenCalledWith(1);
  view.rerender(<Editor open={false} />);
  await tick();
  expect(vi.mocked(putRoomStudyNote).mock.lastCall?.[3]).toEqual({
    expected_version: 5,
    entries: [
      { page: 1, text: "Một" },
      { page: 2, text: "Hai" },
    ],
  });
});
function conflict(code: string) {
  return new APIRequestError(409, {
    code,
    status: 409,
    title: code,
    type: "about:blank",
  });
}
it("reloads a conflicting record, keeps the draft, and retries at the new version including other pages", async () => {
  vi.mocked(putRoomStudyNote).mockRejectedValueOnce(
    conflict("room_document_version_conflict"),
  );
  vi.mocked(getRoomStudyNote)
    .mockResolvedValueOnce(record(2))
    .mockResolvedValueOnce(
      record(7, [
        { page: 1, text: "Autre" },
        { page: 3, text: "Bài 3" },
      ]),
    );
  render(<Editor />);
  await tick();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Của tôi" },
  });
  await tick(800);
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByRole("textbox")).toHaveValue("Của tôi");
  await tick(1000);
  expect(putRoomStudyNote).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
  await tick();
  expect(vi.mocked(putRoomStudyNote).mock.lastCall?.[3]).toEqual({
    expected_version: 7,
    entries: [
      { page: 1, text: "Của tôi" },
      { page: 3, text: "Bài 3" },
    ],
  });
});
it("shows the note quota response and retains the input for retry", async () => {
  vi.mocked(putRoomStudyNote).mockRejectedValueOnce(
    conflict("room_document_note_limit_exceeded"),
  );
  render(<Editor />);
  await tick();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Chưa lưu" },
  });
  await tick(800);
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByRole("textbox")).toHaveValue("Chưa lưu");
  expect(screen.getByRole("button", { name: "Thử lại" })).toBeVisible();
});
