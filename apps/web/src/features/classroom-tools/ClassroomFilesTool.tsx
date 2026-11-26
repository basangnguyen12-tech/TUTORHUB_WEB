import { Button } from "@tutorhub/ui";
import { RefreshCw } from "lucide-react";
import {
  Component,
  lazy,
  Suspense,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "../../app/i18n";
import type { WhiteboardSnippetBridge } from "../collaboration/whiteboardSnippetBridge";
import { ClassroomHeaderSlotContext } from "../media/ClassroomMediaShell";
import type { CodePresenceRoster } from "./codePresence";
import type { ClassroomFilesSession } from "./filesSession";
import { FilesChatContext, type FilesChatActions } from "./filesChatContext";
import { ClassroomToolActionsContext } from "./toolActions";

/**
 * ROOM-TOOLS-FILES-01B / ADR-0045 §1, §3: the Documents (`Tài liệu`) tool's
 * stage content. Only this small wrapper lives in the room chunk; the room
 * library, the pdf.js viewer and the whiteboard snippet encoder load through
 * `React.lazy` (`LazyDocumentViewer-*`), adding 0 bytes to the entry chunk.
 */
export interface ClassroomFilesToolProps {
  readonly chatActions?: FilesChatActions;
  readonly actorID: string;
  /**
   * ROOM-TOOLS-FILES-02B: `classroom_pdf_collaboration` is on as well
   * ("Trình chiếu lớp", page-scoped ink, laser). Off keeps Slice 1 exactly
   * and never requests `/pdf-presentation`.
   */
  readonly collaborationEnabled?: boolean;
  /** The viewer's display name for presence. */
  readonly displayName?: string;
  /**
   * `classroom_files_tool` and `file_uploads` are both on. `undefined` while
   * tenant capabilities load; `false` (off or unreadable) renders feature-off.
   */
  readonly enabled?: boolean;
  readonly mediaSpaceID: string;
  /** The server roster (8-tone presence) shared with the Code tool. */
  readonly presenceRoster?: CodePresenceRoster | null;
  readonly session: ClassroomFilesSession;
  /** Room bridge for "Đưa sang Bảng trắng"; absent hides the action. */
  readonly snippetBridge?: WhiteboardSnippetBridge;
  readonly tenantID: string;
  /**
   * Display hint from the polled whiteboard projection: `false` when the
   * viewer can only watch the board. The whiteboard re-checks on insert.
   */
  readonly whiteboardCanEdit?: boolean;
  /** `classroom_whiteboards` is on for the tenant. */
  readonly whiteboardEnabled?: boolean;
}

function loadViewer() {
  return import("./LazyDocumentViewer");
}

class FilesToolErrorBoundary extends Component<
  {
    children: ReactNode;
    fallback: (retry: () => void) => ReactNode;
    onRetry: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed
      ? this.props.fallback(this.props.onRetry)
      : this.props.children;
  }
}

export function ClassroomFilesTool({
  chatActions,
  enabled,
  ...props
}: ClassroomFilesToolProps) {
  const { t } = useI18n();
  const headerSlot = useContext(ClassroomHeaderSlotContext);
  const toolActions = useContext(ClassroomToolActionsContext);
  // A new lazy component per attempt, so Retry really re-imports the chunk.
  const [attempt, setAttempt] = useState(0);
  const [Viewer, setViewer] = useState(() => lazy(loadViewer));

  if (enabled === false) {
    return (
      <div className="classroom-code-state" role="status">
        <p className="classroom-code-state__title">
          {t("classroomTools.files.featureOff")}
        </p>
        <p>{t("classroomTools.files.featureOffDescription")}</p>
      </div>
    );
  }
  if (enabled === undefined) {
    return (
      <div className="classroom-code-state" role="status">
        <span aria-hidden="true" className="classroom-code-state__spinner" />
        <p>{t("classroomTools.files.loading")}</p>
      </div>
    );
  }
  if (!props.tenantID || !props.actorID || !props.mediaSpaceID) {
    return (
      <div className="classroom-code-state" role="alert">
        <p className="classroom-code-state__title">
          {t("classroomTools.files.forbiddenTitle")}
        </p>
        <p>{t("classroomTools.files.forbiddenDescription")}</p>
      </div>
    );
  }

  return (
    <FilesToolErrorBoundary
      fallback={(retry) => (
        <div className="classroom-code-state" role="alert">
          <p className="classroom-code-state__title">
            {t("classroomTools.files.loadErrorTitle")}
          </p>
          <p>{t("classroomTools.files.loadErrorDescription")}</p>
          <Button
            leadingIcon={<RefreshCw />}
            onClick={retry}
            variant="secondary"
          >
            {t("state.retry")}
          </Button>
        </div>
      )}
      key={attempt}
      onRetry={() => {
        setViewer(() => lazy(loadViewer));
        setAttempt((value) => value + 1);
      }}
    >
      <Suspense
        fallback={
          <div className="classroom-code-state" role="status">
            <span
              aria-hidden="true"
              className="classroom-code-state__spinner"
            />
            <p>{t("classroomTools.files.loading")}</p>
          </div>
        }
      >
        <FilesChatContext.Provider value={chatActions ?? {}}>
          <Viewer
            {...props}
            headerSlot={headerSlot === null ? undefined : headerSlot.element}
            toolActions={toolActions}
          />
        </FilesChatContext.Provider>
      </Suspense>
    </FilesToolErrorBoundary>
  );
}
