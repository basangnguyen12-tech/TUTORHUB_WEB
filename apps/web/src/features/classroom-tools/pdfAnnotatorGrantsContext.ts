import { createContext } from "react";

/**
 * ROOM-TOOLS-FILES-02B (ADR-0045 §4 Slice 2): the room's temporary PDF
 * annotator grants ("Cho phép vẽ lên Tài liệu"), provided by the room page
 * around `<ClassroomLiveKitRoom>` next to the Code edit grants, so the People
 * panel can show a badge and grant/revoke actions without new props on the
 * LiveKit room or the media shell. Every flag is a server projection; `null`
 * (the default) means no PDF presentation exists in the room.
 */
export type ClassroomPdfAnnotatorGrantError = "limit" | "failed";

export interface ClassroomPdfAnnotatorGrantsModel {
  /** Participant keys holding an unexpired annotator grant (projection). */
  readonly activeParticipantKeys: ReadonlySet<string>;
  /** `can_manage_annotator_grants` and the presentation is open. */
  readonly canManage: boolean;
  readonly error: ClassroomPdfAnnotatorGrantError | null;
  readonly maxAnnotators: number;
  /** The participant whose grant change is in flight, if any. */
  readonly pendingParticipantKey: string | null;
  readonly onDismissError: () => void;
  readonly onGrant: (participantKey: string) => void;
  readonly onRevoke: (participantKey: string) => void;
}

export const ClassroomPdfAnnotatorGrantsContext =
  createContext<ClassroomPdfAnnotatorGrantsModel | null>(null);
