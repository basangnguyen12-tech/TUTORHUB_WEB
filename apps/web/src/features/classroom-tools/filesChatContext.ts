import { createContext } from "react";

export interface FilesChatActions {
  readonly share?: (text: string) => void;
  readonly saveAttachment?: (id: string) => Promise<boolean>;
}

export const FilesChatContext = createContext<FilesChatActions>({});
