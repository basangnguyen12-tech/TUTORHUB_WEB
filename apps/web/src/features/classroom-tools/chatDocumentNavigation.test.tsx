// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import LazyDocumentViewer from "./LazyDocumentViewer";
import type { DocumentLoaderProps } from "./DocumentLoader";
import type { PdfPresentationStageProps } from "./PdfPresentationStage";
import {
  createClassroomFilesSession,
  type ClassroomFilesViewState,
} from "./filesSession";
import { useChatPageRequest } from "./useChatPageRequest";

const presented = "f9ae5768-cb27-4dce-8c10-33b71da0aa8a";
const another = "cd09008b-7407-46ae-8cd7-c5b09b5ec2b4";
vi.mock("@tutorhub/api-client", async (original) => ({
  ...(await original<typeof import("@tutorhub/api-client")>()),
  listRoomDocuments: async () => ({
    items: [],
    next_cursor: null,
    viewer_access: { can_manage: false, can_present: false },
  }),
}));
vi.mock("../../app/pdfPresentations", async (original) => ({
  ...(await original<typeof import("../../app/pdfPresentations")>()),
  usePdfPresentationTool: () => ({
    isSuccess: true,
    data: {
      can_present: false,
      presentation: {
        id: "pd-class",
        file_id: presented,
        document: {},
        status: "open",
        current_generation: 1,
        revoke_generation: 0,
        viewer_capabilities: { can_exchange_grant: true },
      },
    },
  }),
}));
vi.mock("./DocumentLoader", () => ({
  DocumentLoader: ({ view }: DocumentLoaderProps) => (
    <output>{`mine ${view.document.fileID} ${view.page}`}</output>
  ),
}));
vi.mock("./PdfPresentationStage", () => ({
  PdfPresentationStage: ({
    presentation,
    chatPageRequest,
  }: PdfPresentationStageProps) => (
    <output>{`class ${presentation.file_id} ${chatPageRequest?.page ?? 1}`}</output>
  ),
}));

afterEach(cleanup);

function view(fileID: string, page: number): ClassroomFilesViewState {
  return {
    document: {
      activeContent: false,
      fileID,
      displayName: "worksheet.pdf",
      firstPageAspect: 0.7,
      mediaType: "application/pdf",
      pageCount: 10,
      versionID: "v1",
    },
    fitMode: "page",
    zoom: 1,
    page,
  };
}

it("opens a different referenced document privately, then a matching reference on the live stage", async () => {
  const session = createClassroomFilesSession();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLanguage="vi">
        <LazyDocumentViewer
          actorID="actor"
          collaborationEnabled
          headerSlot={undefined}
          mediaSpaceID="room"
          session={session}
          tenantID="tenant"
          toolActions={null}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText("class " + presented + " 1"),
  ).toBeInTheDocument();
  act(() => session.openFromChat(view(another, 7), "reference"));
  expect(await screen.findByText("mine " + another + " 7")).toBeInTheDocument();
  act(() => session.openFromChat(view(another, 3), "reference"));
  expect(await screen.findByText("mine " + another + " 3")).toBeInTheDocument();
  act(() => session.openFromChat(view(presented, 4), "reference"));
  expect(
    await screen.findByText("class " + presented + " 4"),
  ).toBeInTheDocument();
  act(() => session.openFromChat(view("chat:123", 1), "private"));
  expect(await screen.findByText("mine chat:123 1")).toBeInTheDocument();
});

it("waits for the page, honors follow lock and consumes each chat jump once", () => {
  const manual = vi.fn(),
    scroll = vi.fn(),
    onHandled = vi.fn();
  const { rerender } = renderHook(
    ({ ready, locked, sequence }) =>
      useChatPageRequest(
        { page: 4, sequence, onHandled },
        ready,
        locked,
        manual,
        scroll,
      ),
    {
      initialProps: { ready: false, locked: true, sequence: 1 },
    },
  );
  expect(onHandled).not.toHaveBeenCalled();
  rerender({ ready: true, locked: true, sequence: 1 });
  rerender({ ready: true, locked: false, sequence: 1 });
  expect(onHandled).toHaveBeenCalledOnce();
  expect(manual).not.toHaveBeenCalled();
  expect(scroll).not.toHaveBeenCalled();
  rerender({ ready: true, locked: false, sequence: 2 });
  rerender({ ready: true, locked: false, sequence: 2 });
  expect(manual).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenCalledWith(4);
});
