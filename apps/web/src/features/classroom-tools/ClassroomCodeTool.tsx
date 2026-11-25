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

export function ClassroomCodeTool(props: ClassroomCodeToolProps) {
  const { t } = useI18n();
  const headerSlot = useContext(ClassroomHeaderSlotContext);
  const toolActions = useContext(ClassroomToolActionsContext);
  // A new lazy component per attempt, so Retry really re-imports the chunk.
  const [attempt, setAttempt] = useState(0);
  const [Workspace, setWorkspace] = useState(() => lazy(loadWorkspace));

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
