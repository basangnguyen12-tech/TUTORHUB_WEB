import { createContext } from "react";

/**
 * ROOM-TOOLS-CODE-02B (ADR-0043 Slice 2): the room's temporary Code edit
 * grants, provided by the room page around `<ClassroomLiveKitRoom>` so the
 * People panel can show a `✎` badge and grant/revoke actions without new
 * props on the LiveKit room or the media shell. Every flag is a server
 * projection; `null` (the default) means no shared code session exists.
 */
export type ClassroomCodeEditorGrantError = "limit" | "failed";

export interface ClassroomCodeEditorGrantsModel {
  /** Participant keys holding an unexpired edit grant (server projection). */
  readonly activeParticipantKeys: ReadonlySet<string>;
  /** `can_manage_editor_grants` and the shared workspace is open. */
  readonly canManage: boolean;
  readonly error: ClassroomCodeEditorGrantError | null;
  readonly maxEditors: number;
  /** The participant whose grant change is in flight, if any. */
  readonly pendingParticipantKey: string | null;
  readonly onDismissError: () => void;
  readonly onGrant: (participantKey: string) => void;
  readonly onRevoke: (participantKey: string) => void;
}

export const ClassroomCodeEditorGrantsContext =
  createContext<ClassroomCodeEditorGrantsModel | null>(null);
