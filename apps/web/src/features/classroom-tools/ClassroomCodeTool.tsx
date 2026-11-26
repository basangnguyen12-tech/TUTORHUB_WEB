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
import { ClassroomHeaderSlotContext } from "../media/ClassroomMediaShell";
import { CHAT_MAX_MESSAGE_CHARACTERS } from "../media/classroomChatMedia";
import type { CodePresenceRoster } from "./codePresence";
import type { ClassroomCodeSession } from "./codeSession";
import { ClassroomToolActionsContext } from "./toolActions";

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §1–§2: the Code tool's stage content. Only
 * this small wrapper lives in the room chunk; the CodeMirror workspace, the
 * sandbox controller and the snippet library load through `React.lazy`
 * (`LazyCodeWorkspace-*`), adding 0 bytes to the client entry chunk.
 */
export interface ClassroomCodeToolProps {
  readonly actorID: string;
  /** Whether the viewer may post in room chat right now (ADR-0042). */
  readonly chatCanPost: boolean;
  /**
   * ROOM-TOOLS-CODE-03B: the class behind the room, when the server projects
   * one — enables the "Của lớp" snippets. `null` for study meetings.
   */
  readonly classID?: string | null;
  /**
   * ROOM-TOOLS-CODE-02B: the server roster (participant keys, sequences and
   * names) used to colour shared-workspace cursors with the 8-tone palette.
   */
  readonly codeRoster?: CodePresenceRoster | null;
  /**
   * `classroom_code_tool` and `classroom_code_collaboration` are both on:
   * the tool offers "Chung lớp" beside "Nháp của tôi". Off (the default)
   * keeps the Slice 1 personal workspace exactly.
   */
  readonly collaborationEnabled?: boolean;
  /** Fallback presence name when the roster has no entry for the viewer. */
  readonly displayName?: string;
  /**
   * Server-projected `classroom_code_tool` (ROOM-TOOLS-CODE-02A). `undefined`
   * while tenant capabilities load; `false` renders the feature-off state.
   */
  readonly enabled?: boolean;
  /**
   * ROOM-TOOLS-CODE-03B: shows teaching-staff UI ("Bài học sinh", class
   * snippets). Display only — the server enforces every right (404/403).
   */
  readonly isStaff?: boolean;
  /**
   * ROOM-TOOLS-CODE-03B: `classroom_code_tool` and `code_snippet_library` are
   * both on — durable snippets, the server draft and "Gửi bài cho GV". Off
   * (the default) keeps Slice 1/2 exactly: no library or scratchpad calls.
   */
  readonly libraryEnabled?: boolean;
  readonly mediaSpaceID: string;
  readonly onSendToChat?: (text: string) => void;
  readonly session: ClassroomCodeSession;
  readonly tenantID: string;
}

function loadWorkspace() {
  return import("./LazyCodeWorkspace");
}

class CodeToolErrorBoundary extends Component<
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

export function ClassroomCodeTool({
  enabled,
  ...props
}: ClassroomCodeToolProps) {
  const { t } = useI18n();
  const headerSlot = useContext(ClassroomHeaderSlotContext);
  const toolActions = useContext(ClassroomToolActionsContext);
  // A new lazy component per attempt, so Retry really re-imports the chunk.
  const [attempt, setAttempt] = useState(0);
  const [Workspace, setWorkspace] = useState(() => lazy(loadWorkspace));

  if (enabled === false) {
    return (
      <div className="classroom-code-state" role="status">
        <p className="classroom-code-state__title">
          {t("classroomTools.code.featureOff")}
        </p>
      </div>
    );
  }
  if (enabled === undefined) {
    return (
      <div className="classroom-code-state" role="status">
        <span aria-hidden="true" className="classroom-code-state__spinner" />
        <p>{t("classroomTools.code.loading")}</p>
      </div>
    );
  }
  if (!props.tenantID || !props.actorID || !props.mediaSpaceID) {
    return (
      <div className="classroom-code-state" role="alert">
        <p className="classroom-code-state__title">
          {t("classroomTools.code.forbiddenTitle")}
        </p>
        <p>{t("classroomTools.code.forbiddenDescription")}</p>
      </div>
    );
  }

  return (
    <CodeToolErrorBoundary
      fallback={(retry) => (
        <div className="classroom-code-state" role="alert">
          <p className="classroom-code-state__title">
            {t("classroomTools.code.loadErrorTitle")}
          </p>
          <p>{t("classroomTools.code.loadErrorDescription")}</p>
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
        setWorkspace(() => lazy(loadWorkspace));
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
            <p>{t("classroomTools.code.loading")}</p>
          </div>
        }
      >
        <Workspace
          {...props}
          chatMaxCharacters={CHAT_MAX_MESSAGE_CHARACTERS}
          headerSlot={headerSlot === null ? undefined : headerSlot.element}
          toolActions={toolActions}
        />
      </Suspense>
    </CodeToolErrorBoundary>
  );
}
