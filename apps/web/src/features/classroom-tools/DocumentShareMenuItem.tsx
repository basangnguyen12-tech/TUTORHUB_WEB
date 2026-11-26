import { MenuItem } from "@tutorhub/ui";
import { MessageSquare } from "lucide-react";
import { useContext } from "react";
import { useI18n } from "../../app/i18n";
import { formatDocumentReference } from "./documentReference";
import { FilesChatContext } from "./filesChatContext";
import type { ClassroomFilesOpenDocument } from "./filesSession";
import { ClassroomToolActionsContext } from "./toolActions";

export function DocumentShareMenuItem({
  document,
  page,
}: {
  readonly document: ClassroomFilesOpenDocument;
  readonly page: number;
}) {
  const { t } = useI18n();
  const { share } = useContext(FilesChatContext);
  const actions = useContext(ClassroomToolActionsContext);
  if (!share || !actions) return null;
  const block = formatDocumentReference(
    document.fileID,
    document.displayName,
    page,
    document.mediaType,
  );
  if (!block) return null;
  return (
    <MenuItem
      onSelect={() => {
        share(block);
        actions.openChat();
      }}
    >
      <MessageSquare aria-hidden="true" />
      {t("classroomTools.files.chat.share", { page })}
    </MenuItem>
  );
}
