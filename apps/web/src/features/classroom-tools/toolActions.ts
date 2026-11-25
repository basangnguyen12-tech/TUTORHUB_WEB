import { createContext } from "react";
import type { ClassroomToolID } from "./registry";

/**
 * ROOM-TOOLS-CODE-01: room-level actions the classroom shell offers to the
 * content it hosts (tool stage, chat inspector). The Code tool uses
 * `openChat` after "Send to chat" prefills the composer, and the chat panel
 * uses `openTool("code")` for "Open in Code". `null` outside a classroom.
 */
export interface ClassroomToolActions {
  /** Brings a registered tool onto the stage (never toggles it closed). */
  readonly openTool: (id: ClassroomToolID) => boolean;
  /** Opens the chat inspector; `false` when the room has no chat. */
  readonly openChat: () => boolean;
  /** Whether a tool is registered in this room. */
  readonly hasTool: (id: ClassroomToolID) => boolean;
}

export const ClassroomToolActionsContext =
  createContext<ClassroomToolActions | null>(null);
