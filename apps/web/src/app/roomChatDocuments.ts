import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  rotateCSRFToken,
  saveRoomChatAttachment,
  type RoomDocument,
  type RoomDocumentPage,
} from "@tutorhub/api-client";
import { useEffect, useRef } from "react";
import type { ChatDocumentReference } from "../features/classroom-tools/documentReference";
import type {
  ClassroomFilesSession,
  ClassroomFilesViewState,
} from "../features/classroom-tools/filesSession";
import { getApiBaseUrl } from "./classFiles";
import { roomDocumentQueryKeys, useRoomDocuments } from "./roomDocuments";

export function roomDocumentView(
  document: RoomDocument,
  page = 1,
): ClassroomFilesViewState {
  const pageCount = Math.max(1, document.page_count ?? 1);
  return {
    document: {
      activeContent: document.active_content,
      displayName: document.display_name,
      fileID: document.id,
      firstPageAspect: document.first_page_aspect ?? 0.7071,
      mediaType: document.declared_media_type,
      pageCount,
      versionID: null,
    },
    fitMode: "width",
    page: Math.min(page, pageCount),
    zoom: 1,
  };
}

/** SHA-256 name-based UUID (v8), stable on retries and across reloads. */
export async function chatImportRequestID(
  tenantID: string,
  roomID: string,
  actorID: string,
  attachmentID: string,
  scope: "media_space" | "class",
): Promise<string> {
  const input = new TextEncoder().encode(
    JSON.stringify([
      "room-chat-import",
      tenantID,
      roomID,
      actorID,
      attachmentID,
      scope,
    ]),
  );
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", input),
  ).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function useRoomChatDocuments(
  tenantID: string,
  roomID: string,
  actorID: string,
  conversationID: string | undefined,
  options: {
    readonly enabled: boolean;
    readonly chatOpen: boolean;
    readonly roomOpen: boolean;
    readonly session: ClassroomFilesSession;
  },
) {
  const { enabled, chatOpen, roomOpen, session } = options;
  const client = useQueryClient();
  const library = useRoomDocuments(tenantID, roomID, enabled && chatOpen);
  const key = roomDocumentQueryKeys.list(tenantID, roomID);
  const imports = useRef(
    new Map<
      string,
      { controller: AbortController; request: Promise<RoomDocument> }
    >(),
  );
  useEffect(() => {
    const pending = imports.current;
    const cancel = () => {
      for (const operation of pending.values()) operation.controller.abort();
      pending.clear();
    };
    const unsubscribe = session.subscribe(cancel);
    return () => {
      unsubscribe();
      cancel();
    };
  }, [session]);
  // Never trust the filename, MIME or file permission asserted in a chat message.
  const openReference = async (reference: ChatDocumentReference) => {
    const current = session.beginChatOpen();
    // A teacher can import or revoke access after this participant opened Chat.
    let result = await library.refetch();
    let checkedPages = 0;
    const seenCursors = new Set<string>();
    let row: RoomDocument | undefined;
    while (current() && !result.isError) {
      const pages = result.data?.pages ?? [];
      row = pages
        .slice(checkedPages)
        .flatMap((page) => page.items)
        .find((item) => item.id === reference.fileId);
      const next = pages.at(-1)?.next_cursor;
      if (row || !next || seenCursors.has(next)) break;
      checkedPages = pages.length;
      seenCursors.add(next);
      result = await library.fetchNextPage();
    }
    if (!current()) return false;
    if (!row || !row.viewer_access.can_view || row.status !== "ready")
      throw new Error("room_document_unavailable");
    session.openFromChat(roomDocumentView(row, reference.page), "reference");
    return true;
  };
  const canSave =
    enabled &&
    roomOpen &&
    conversationID &&
    library.data?.pages[0]?.viewer_access.can_manage === true;
  const importAttachment = async (
    attachmentID: string,
    conversation: string,
    signal: AbortSignal,
  ) => {
    const requestOptions = { baseUrl: getApiBaseUrl(), signal };
    const csrf = await rotateCSRFToken(requestOptions);
    const id = await chatImportRequestID(
      tenantID,
      roomID,
      actorID,
      attachmentID,
      "media_space",
    );
    signal.throwIfAborted();
    const row = await saveRoomChatAttachment(
      tenantID,
      roomID,
      {
        attachment_id: attachmentID,
        client_request_id: id,
        conversation_id: conversation,
        scope: "media_space",
      },
      csrf.csrf_token,
      requestOptions,
    );
    signal.throwIfAborted();
    if (row.status !== "ready" || !row.viewer_access.can_view)
      throw new Error("room_document_import_unavailable");
    client.setQueryData<InfiniteData<RoomDocumentPage>>(
      key,
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page, index) => ({
            ...page,
            items: [
              ...(index === 0 ? [row] : []),
              ...page.items.filter((item) => item.id !== row.id),
            ],
          })),
        },
    );
    void client.invalidateQueries({ queryKey: key });
    return row;
  };
  const saveAttachment = async (attachmentID: string) => {
    if (!canSave || !conversationID)
      throw new Error("room_document_import_unavailable");
    const current = session.beginChatOpen();
    let operation = imports.current.get(attachmentID);
    if (!operation) {
      const controller = new AbortController();
      const request = importAttachment(
        attachmentID,
        conversationID,
        controller.signal,
      ).finally(() => {
        if (imports.current.get(attachmentID)?.controller === controller)
          imports.current.delete(attachmentID);
      });
      operation = { controller, request };
      imports.current.set(attachmentID, operation);
    }
    const row = await operation.request;
    if (!current()) return false;
    session.openFromChat(roomDocumentView(row), "private");
    return true;
  };
  return {
    openReference: enabled ? openReference : undefined,
    saveAttachment: canSave ? saveAttachment : undefined,
  };
}
