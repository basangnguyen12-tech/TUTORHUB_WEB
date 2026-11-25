import type { Extension } from "@codemirror/state";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  APIRequestError,
  type CodeWorkspace,
  type CodeWorkspaceEditorGrant,
  type CodeWorkspaceProjection,
} from "@tutorhub/api-client";
import type {
  CanonicalCodeWorkspaceAuthority,
  CodeWorkspaceFileInput,
  CollaborationCapability,
  CollaborationConnectionStatus,
} from "@tutorhub/collaboration-client";
import { Button } from "@tutorhub/ui";
import { Play, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  requestCodeWorkspaceGrant,
  useCreateCodeWorkspace,
  useTransitionCodeWorkspace,
  type CodeWorkspaceOperation,
} from "../../app/codeWorkspaces";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  createRemoteCursorAwareness,
  remotePresenceIdentity,
  type CodeAwarenessLike,
  type CodePresenceRoster,
  type RemoteCursorAwareness,
} from "./codePresence";
import type { ClassroomCodeWorkspaceSnapshot } from "./codeSession";
import type { CodeForkResult } from "./codeWorkspaceModel";
import type * as LiveCollaboration from "./liveCodeCollaboration";

/**
 * ROOM-TOOLS-CODE-02B (ADR-0043 Slice 2): the "Chung lớp" pane. It renders
 * the server projection's states (not started, suspended, ended, errors)
 * with the teacher's one-tap Start / Resume, and while the workspace is open
 * it owns the Hocuspocus session: the session is keyed by
 * `(workspace, generation, revoke generation, capability)`, and a new key
 * (an edit grant given or revoked, a new generation) swaps the session while
 * the previous editor stays on screen read-only, so the stage never unmounts.
 * The Yjs code is loaded with `import()` only here.
 */
export interface LiveLifecycleActions {
  readonly canClose: boolean;
  readonly canResume: boolean;
  readonly canSuspend: boolean;
  readonly onTransition: (operation: CodeWorkspaceOperation) => void;
  readonly pending: boolean;
}

export interface LiveWorkspaceBinding {
  readonly authority: CanonicalCodeWorkspaceAuthority;
  /** Raw provider awareness (presence publishing and reading). */
  readonly awareness: CodeAwarenessLike | null;
  readonly capability: CollaborationCapability;
  readonly connection: CollaborationConnectionStatus;
  /** CodeMirror binding for one shared file. */
  readonly createExtensions: (fileId: string, onLimit: () => void) => Extension;
  readonly fallbackName: string;
  /** The viewer's own temporary edit grant, when it has one. */
  readonly grantExpiresAt: string | null;
  /** The file to open first (the presenter's, else the shared active one). */
  readonly initialFileId: () => string | null;
  /** Session fence; a new key is a swapped session. */
  readonly key: string;
  readonly lifecycle: LiveLifecycleActions;
  readonly notice?: ReactNode;
  readonly onFork: (result: CodeForkResult) => void;
  readonly readOnly: boolean;
  readonly roster: CodePresenceRoster | null;
}

export interface LiveCodeWorkspaceProps {
  readonly actorID: string;
  readonly fallbackFiles: readonly CodeWorkspaceFileInput[];
  readonly fallbackName: string;
  readonly mediaSpaceID: string;
  /** Polite announcement in the tool's status region. */
  readonly onAnnounce: (text: string) => void;
  readonly onFork: (result: CodeForkResult) => void;
  readonly onOpenMine: () => void;
  readonly renderWorkspace: (live: LiveWorkspaceBinding) => ReactNode;
  readonly roster: CodePresenceRoster | null;
  /** The personal draft, used to seed an empty shared workspace. */
  readonly seedSnapshot: () => ClassroomCodeWorkspaceSnapshot | null;
  readonly tenantID: string;
  readonly tool: UseQueryResult<CodeWorkspaceProjection, Error>;
}

type ToolErrorState = "error" | "featureOff" | "forbidden";

function classifyToolError(error: Error): ToolErrorState {
  if (error instanceof APIRequestError) {
    if (error.status === 503) return "featureOff";
    if ([401, 403, 404].includes(error.status)) return "forbidden";
  }
  return "error";
}

const TOOL_ERROR_KEYS: Readonly<Record<ToolErrorState, TranslationKey>> = {
  error: "classroomTools.live.error",
  featureOff: "classroomTools.live.featureOff",
  forbidden: "classroomTools.live.forbidden",
};

export function LiveCodeWorkspace({
  actorID,
  fallbackFiles,
  fallbackName,
  mediaSpaceID,
  onAnnounce,
  onFork,
  onOpenMine,
  renderWorkspace,
  roster,
  seedSnapshot,
  tenantID,
  tool,
}: LiveCodeWorkspaceProps) {
  const { t } = useI18n();
  const create = useCreateCodeWorkspace(tenantID, mediaSpaceID);
  const transition = useTransitionCodeWorkspace(tenantID, mediaSpaceID);
  const [mutationFailed, setMutationFailed] = useState(false);
  const pending = create.isPending || transition.isPending;
  // Stable for the session binding: always the latest projected workspace.
  const workspaceRef = useRef(tool.data?.workspace ?? null);
  useLayoutEffect(() => {
    workspaceRef.current = tool.data?.workspace ?? null;
  });
  const { mutate: mutateTransition } = transition;
  const runTransition = useCallback(
    (operation: CodeWorkspaceOperation) => {
      const target = workspaceRef.current;
      if (!target) return;
      setMutationFailed(false);
      mutateTransition(
        { operation, workspace: target },
        { onError: () => setMutationFailed(true) },
      );
    },
    [mutateTransition],
  );

  if (tool.isPending) {
    return <LiveState busy message={t("classroomTools.live.loading")} />;
  }
  if (tool.isError) {
    const state = classifyToolError(tool.error);
    return (
      <LiveState alert={state === "error"} message={t(TOOL_ERROR_KEYS[state])}>
        {state === "error" ? (
          <Button
            leadingIcon={<RefreshCw />}
            onClick={() => void tool.refetch()}
            variant="secondary"
          >
            {t("state.retry")}
          </Button>
        ) : (
          <Button onClick={onOpenMine} variant="secondary">
            {t("classroomTools.live.openMine")}
          </Button>
        )}
      </LiveState>
    );
  }

  const projection = tool.data;
  const workspace = projection.workspace;
  const capabilities = workspace?.viewer_capabilities;

  const start = async () => {
    setMutationFailed(false);
    try {
      let target: CodeWorkspace | null = workspace;
      if (!target || target.status === "closed") {
        target = await create.mutateAsync();
      }
      if (target.status === "created" && target.viewer_capabilities.can_open) {
        await transition.mutateAsync({ operation: "open", workspace: target });
      } else if (
        target.status === "suspended" &&
        target.viewer_capabilities.can_resume
      ) {
        await transition.mutateAsync({
          operation: "resume",
          workspace: target,
        });
      }
    } catch {
      setMutationFailed(true);
    }
  };

  const mutationError = mutationFailed ? (
    <p className="classroom-code-live-error" role="alert">
      {t("classroomTools.live.mutationError")}
    </p>
  ) : null;

  if (workspace?.status === "open" && capabilities) {
    if (!capabilities.can_exchange_grant) {
      return <LiveState message={t("classroomTools.live.forbidden")} />;
    }
    return (
      <>
        {mutationError}
        <LiveCodeSessionView
          actorID={actorID}
          fallbackFiles={fallbackFiles}
          fallbackName={fallbackName}
          grants={projection.active_editor_grants}
          lifecycle={{
            canClose: capabilities.can_close,
            canResume: capabilities.can_resume,
            canSuspend: capabilities.can_suspend,
            onTransition: runTransition,
            pending,
          }}
          onAnnounce={onAnnounce}
          onFork={onFork}
          refetch={tool.refetch}
          renderWorkspace={renderWorkspace}
          roster={roster}
          seedSnapshot={seedSnapshot}
          tenantID={tenantID}
          workspace={workspace}
        />
      </>
    );
  }

  const canStart =
    (workspace === null && projection.can_create) ||
    (workspace?.status === "created" && capabilities?.can_open === true) ||
    (workspace?.status === "closed" && projection.can_create);
  const canResume =
    workspace?.status === "suspended" && capabilities?.can_resume === true;
  const coordinator = canStart || canResume;

  const title: TranslationKey = coordinator
    ? canResume
      ? "classroomTools.live.suspendedTitle"
      : "classroomTools.live.readyTitle"
    : workspace?.status === "suspended"
      ? "classroomTools.live.suspendedTitle"
      : workspace?.status === "closed"
        ? "classroomTools.live.closedTitle"
        : "classroomTools.live.notStartedTitle";
  const description: TranslationKey = coordinator
    ? canResume
      ? "classroomTools.live.resumeDescription"
      : "classroomTools.live.readyDescription"
    : workspace?.status === "suspended"
      ? "classroomTools.live.suspendedDescription"
      : workspace?.status === "closed"
        ? "classroomTools.live.closedDescription"
        : "classroomTools.live.notStartedDescription";

  return (
    <LiveState description={t(description)} message={t(title)}>
      {canStart ? (
        <Button
          disabled={pending}
          leadingIcon={<Play />}
          onClick={() => void start()}
        >
          {pending
            ? t("classroomTools.live.starting")
            : t("classroomTools.live.start")}
        </Button>
      ) : null}
      {canResume ? (
        <Button
          disabled={pending}
          leadingIcon={<Play />}
          onClick={() => runTransition("resume")}
        >
          {t("classroomTools.live.resume")}
        </Button>
      ) : null}
      <Button onClick={onOpenMine} variant="secondary">
        {t("classroomTools.live.openMine")}
      </Button>
      {mutationError}
    </LiveState>
  );
}

function LiveState({
  alert = false,
  busy = false,
  children,
  description,
  message,
}: {
  readonly alert?: boolean;
  readonly busy?: boolean;
  readonly children?: ReactNode;
  readonly description?: string;
  readonly message: string;
}) {
  return (
    <div className="classroom-code classroom-code--live-state">
      <div className="classroom-code-state">
        {busy ? (
          <span aria-hidden="true" className="classroom-code-state__spinner" />
        ) : null}
        <div role={alert ? "alert" : "status"}>
          <p className="classroom-code-state__title">{message}</p>
          {description ? <p>{description}</p> : null}
        </div>
        {children ? (
          <div className="classroom-code-state__actions">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

interface SessionEntry {
  readonly capability: CollaborationCapability;
  readonly cursor: RemoteCursorAwareness | null;
  readonly destroy: () => void;
  readonly key: string;
  readonly module: typeof LiveCollaboration;
  readonly session: LiveCollaboration.LiveCodeSession;
}

function LiveCodeSessionView({
  actorID,
  fallbackFiles,
  fallbackName,
  grants,
  lifecycle,
  onAnnounce,
  onFork,
  refetch,
  renderWorkspace,
  roster,
  seedSnapshot,
  tenantID,
  workspace,
}: {
  readonly actorID: string;
  readonly fallbackFiles: readonly CodeWorkspaceFileInput[];
  readonly fallbackName: string;
  readonly grants: readonly CodeWorkspaceEditorGrant[];
  readonly lifecycle: LiveLifecycleActions;
  readonly onAnnounce: (text: string) => void;
  readonly onFork: (result: CodeForkResult) => void;
  readonly refetch: () => Promise<unknown>;
  readonly renderWorkspace: (live: LiveWorkspaceBinding) => ReactNode;
  readonly roster: CodePresenceRoster | null;
  readonly seedSnapshot: () => ClassroomCodeWorkspaceSnapshot | null;
  readonly tenantID: string;
  readonly workspace: CodeWorkspace;
}) {
  const { t } = useI18n();
  const capability = workspace.viewer_capabilities.capability;
  const workspaceID = workspace.id;
  const generation = workspace.current_generation;
  const revokeGeneration = workspace.revoke_generation;
  const key = `${workspaceID}:${generation}:${revokeGeneration}:${capability}`;
  const [entry, setEntry] = useState<SessionEntry | null>(null);
  const [connection, setConnection] =
    useState<CollaborationConnectionStatus>("connecting");
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [terminalKey, setTerminalKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const entryRef = useRef<SessionEntry | null>(null);
  // The projection re-renders often (room clock, polls); the session effect
  // depends only on its fence, the rest is read through refs.
  const latest = useRef({
    fallbackFiles,
    fallbackName,
    onAnnounce,
    refetch,
    roster,
    seedSnapshot,
    t,
    workspace,
  });
  useLayoutEffect(() => {
    latest.current = {
      fallbackFiles,
      fallbackName,
      onAnnounce,
      refetch,
      roster,
      seedSnapshot,
      t,
      workspace,
    };
  });

  useEffect(() => {
    const abort = new AbortController();
    const fenced: CodeWorkspace = {
      ...latest.current.workspace,
      current_generation: generation,
      id: workspaceID,
      revoke_generation: revokeGeneration,
    };
    const run = async () => {
      const module = await import("./liveCodeCollaboration");
      const grant = await requestCodeWorkspaceGrant(
        tenantID,
        fenced,
        capability,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      let created: SessionEntry | null = null;
      const session = await module.openLiveCodeSession({
        actorID,
        grant,
        initialFiles: module.liveInitialFiles(
          latest.current.seedSnapshot(),
          latest.current.fallbackFiles,
        ),
        onStatus: (status) => {
          if (created && entryRef.current === created) setConnection(status);
        },
        onTerminal: () => {
          if (!created || entryRef.current !== created) return;
          setTerminalKey(created.key);
          // A revoked or expired grant shows up as a new capability.
          void latest.current.refetch();
        },
        tenantID,
      });
      if (abort.signal.aborted) {
        session.destroy();
        return;
      }
      const awareness = session.awareness as CodeAwarenessLike | null;
      const cursor = awareness
        ? createRemoteCursorAwareness(awareness, (state, clientID) =>
            remotePresenceIdentity(
              state,
              clientID,
              latest.current.roster,
              latest.current.fallbackName,
            ),
          )
        : null;
      const next: SessionEntry = {
        capability: session.capability,
        cursor,
        destroy: () => {
          cursor?.destroy();
          session.destroy();
        },
        key,
        module,
        session,
      };
      created = next;
      const previous = entryRef.current;
      entryRef.current = next;
      setEntry(next);
      setConnection("connected");
      setFailedKey(null);
      setTerminalKey(null);
      previous?.destroy();
      if (previous) {
        const strings = latest.current.t;
        if (previous.capability === "view" && next.capability !== "view") {
          latest.current.onAnnounce(strings("classroomTools.live.upgraded"));
        } else if (
          previous.capability !== "view" &&
          next.capability === "view"
        ) {
          latest.current.onAnnounce(strings("classroomTools.live.downgraded"));
        }
      }
    };
    run().catch(() => {
      if (!abort.signal.aborted) setFailedKey(key);
    });
    return () => abort.abort();
  }, [
    actorID,
    attempt,
    capability,
    generation,
    key,
    revokeGeneration,
    tenantID,
    workspaceID,
  ]);

  useEffect(
    () => () => {
      entryRef.current?.destroy();
      entryRef.current = null;
    },
    [],
  );

  const retry = useCallback(() => {
    setFailedKey(null);
    setTerminalKey(null);
    setAttempt((value) => value + 1);
  }, []);

  const selfKey = roster?.selfParticipantKey ?? null;
  const grantExpiresAt =
    (selfKey &&
      grants.find((grant) => grant.participant_key === selfKey)?.expires_at) ||
    null;
  const terminal = entry !== null && terminalKey === entry.key;
  const stale = entry !== null && failedKey === key;
  const readOnly =
    entry === null ||
    entry.capability === "view" ||
    entry.key !== key ||
    terminal;
  const showRetry = terminal || stale;
  const { canClose, canResume, canSuspend, onTransition, pending } = lifecycle;

  const binding = useMemo<LiveWorkspaceBinding | null>(() => {
    if (!entry) return null;
    const authority = entry.session.authority;
    return {
      authority,
      awareness: entry.session.awareness as CodeAwarenessLike | null,
      capability: entry.capability,
      connection: terminal ? "failed" : connection,
      createExtensions: (fileId, onLimit) =>
        entry.module.liveEditorExtensions({
          awareness: entry.cursor,
          fileId,
          onLimit,
          session: entry.session,
        }),
      fallbackName,
      grantExpiresAt: entry.capability === "edit" ? grantExpiresAt : null,
      initialFileId: () => {
        try {
          return entry.capability === "present"
            ? authority.activeFileId()
            : (authority.presenterFileId() ?? authority.activeFileId());
        } catch {
          return null;
        }
      },
      key: entry.key,
      lifecycle: { canClose, canResume, canSuspend, onTransition, pending },
      notice: showRetry ? (
        <button
          className="classroom-code-live-bar__retry"
          onClick={retry}
          type="button"
        >
          <RefreshCw aria-hidden="true" />
          {t("state.retry")}
        </button>
      ) : null,
      onFork,
      readOnly,
      roster,
    };
  }, [
    canClose,
    canResume,
    canSuspend,
    connection,
    entry,
    fallbackName,
    grantExpiresAt,
    onFork,
    onTransition,
    pending,
    readOnly,
    retry,
    roster,
    showRetry,
    t,
    terminal,
  ]);

  if (!binding) {
    if (failedKey === key) {
      return (
        <LiveState alert message={t("classroomTools.live.connectionError")}>
          <Button
            leadingIcon={<RefreshCw />}
            onClick={retry}
            variant="secondary"
          >
            {t("state.retry")}
          </Button>
        </LiveState>
      );
    }
    return (
      <LiveState
        busy
        message={t("classroomTools.live.connection.connecting")}
      />
    );
  }
  return <>{renderWorkspace(binding)}</>;
}
