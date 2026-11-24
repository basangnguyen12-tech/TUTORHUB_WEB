import { APIRequestError, type WhiteboardDocument } from "@tutorhub/api-client";
import { Button } from "@tutorhub/ui";
import { Info, Pause, Play, Square } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useI18n } from "../../app/i18n";
import {
  usePrepareWhiteboard,
  useTransitionWhiteboard,
  useWhiteboardTool,
} from "../../app/whiteboards";
import { WHITEBOARD_PRIVATE_ALPHA_SUPPORT_HREF } from "./whiteboardPrivateAlpha";

const LazyWhiteboardEngine = lazy(() => import("./LazyWhiteboardEngine"));

type WhiteboardOperation = "open" | "suspend" | "resume" | "close";

export interface ClassroomWhiteboardToolProps {
  actorID: string;
  /**
   * One-tap start for the in-room stage: prepare a whiteboard when the server
   * allows creating one, then open it when the server allows opening. Every
   * step stays gated by server-projected capabilities. Defaults to `false` so
   * the discrete manual flow remains available elsewhere.
   */
  autoStart?: boolean;
  enabled: boolean;
  mediaSpaceID: string;
  tenantID: string;
}

export function ClassroomWhiteboardTool({
  actorID,
  autoStart = false,
  enabled,
  mediaSpaceID,
  tenantID,
}: ClassroomWhiteboardToolProps) {
  const { t } = useI18n();
  const tool = useWhiteboardTool(tenantID, mediaSpaceID, enabled);
  const prepare = usePrepareWhiteboard(tenantID, mediaSpaceID);
  const transition = useTransitionWhiteboard(tenantID, mediaSpaceID);
  const { mutate: prepareWhiteboard } = prepare;
  const { mutate: transitionWhiteboard } = transition;
  const autoPreparedSpaceRef = useRef<string | null>(null);
  const autoOpenedDocumentRef = useRef<string | null>(null);
  const manualPauseOrCloseRef = useRef(false);

  const projection =
    enabled && !tool.isPending && !tool.isError ? tool.data : undefined;
  const autoPrepareReady = Boolean(
    autoStart &&
    projection?.document === null &&
    projection.can_create &&
    !prepare.isPending &&
    !prepare.isError,
  );
  const autoOpenDocument =
    autoStart &&
    projection?.document?.status === "created" &&
    projection.document.viewer_capabilities.can_open &&
    !transition.isPending &&
    !transition.isError
      ? projection.document
      : null;

  useEffect(() => {
    if (!autoPrepareReady) return;
    if (autoPreparedSpaceRef.current === mediaSpaceID) return;
    autoPreparedSpaceRef.current = mediaSpaceID;
    prepareWhiteboard();
  }, [autoPrepareReady, mediaSpaceID, prepareWhiteboard]);

  useEffect(() => {
    if (autoOpenDocument === null) return;
    if (manualPauseOrCloseRef.current) return;
    if (autoOpenedDocumentRef.current === autoOpenDocument.id) return;
    autoOpenedDocumentRef.current = autoOpenDocument.id;
    transitionWhiteboard({ document: autoOpenDocument, operation: "open" });
  }, [autoOpenDocument, transitionWhiteboard]);

  const refetchTool = tool.refetch;
  const handleRecoveryRequired = useCallback(() => {
    void refetchTool();
  }, [refetchTool]);

  if (!enabled) {
    return <WhiteboardState message={t("whiteboard.featureOff")} />;
  }
  if (tool.isPending) {
    return (
      <WhiteboardState
        compactPrivateAlphaNotice={autoStart}
        message={t("whiteboard.loading")}
        showPrivateAlphaNotice={!autoStart}
      />
    );
  }
  if (tool.isError) {
    const state = classifyWhiteboardError(tool.error);
    return (
      <WhiteboardState
        alert={state !== "featureOff"}
        showPrivateAlphaNotice
        message={t(`whiteboard.${state}`)}
      >
        {state === "error" ? (
          <Button onClick={() => void tool.refetch()} variant="secondary">
            {t("whiteboard.retry")}
          </Button>
        ) : null}
      </WhiteboardState>
    );
  }

  const resolved = tool.data;
  if (resolved.document === null) {
    return (
      <WhiteboardState
        compactPrivateAlphaNotice={autoStart}
        message={t("whiteboard.empty")}
        showPrivateAlphaNotice={!autoStart}
      >
        {resolved.can_create ? (
          <Button
            disabled={prepare.isPending}
            onClick={() => prepareWhiteboard()}
          >
            {prepare.isPending
              ? t("whiteboard.preparing")
              : t("whiteboard.prepare")}
          </Button>
        ) : null}
        {prepare.isError ? (
          <p className="whiteboard-tool-error" role="alert">
            {t("whiteboard.mutationError")}
          </p>
        ) : null}
      </WhiteboardState>
    );
  }

  const document = resolved.document;
  return (
    <WhiteboardDocumentView
      actorID={actorID}
      document={document}
      mutationPending={transition.isPending}
      onRecoveryRequired={handleRecoveryRequired}
      onTransition={(operation) => {
        // A deliberate pause/finish must never be undone by the one-tap flow;
        // the manual Open/Resume buttons keep working.
        if (operation === "suspend" || operation === "close") {
          manualPauseOrCloseRef.current = true;
        }
        transitionWhiteboard({ document, operation });
      }}
      tenantID={tenantID}
      transitionError={transition.isError}
    />
  );
}

function WhiteboardDocumentView({
  actorID,
  document,
  mutationPending,
  onRecoveryRequired,
  onTransition,
  tenantID,
  transitionError,
}: {
  actorID: string;
  document: WhiteboardDocument;
  mutationPending: boolean;
  onRecoveryRequired: () => void;
  onTransition: (operation: WhiteboardOperation) => void;
  tenantID: string;
  transitionError: boolean;
}) {
  const { t } = useI18n();
  const capabilities = document.viewer_capabilities;
  return (
    <section
      aria-labelledby="whiteboard-tool-title"
      className="whiteboard-tool"
    >
      <header className="whiteboard-tool-header">
        <div className="whiteboard-tool-heading">
          <h3 className="whiteboard-tool-title" id="whiteboard-tool-title">
            {t("whiteboard.title")}
          </h3>
          <p className="whiteboard-tool-status">
            {t(`whiteboard.status.${document.status}`)}
          </p>
        </div>
        <div className="whiteboard-tool-actions">
          {capabilities.can_open ? (
            <Button
              disabled={mutationPending}
              onClick={() => onTransition("open")}
              size="sm"
            >
              {t("whiteboard.open")}
            </Button>
          ) : null}
          {/*
            ROOM-MEET-DOCK-04: icon + label everywhere; inside the classroom
            stylesheet the label is hidden visually (32px round keys) and the
            room tooltip reads `data-tooltip`. The label stays the name.
          */}
          {capabilities.can_suspend ? (
            <Button
              className="whiteboard-action"
              data-tooltip={t("whiteboard.suspend")}
              disabled={mutationPending}
              leadingIcon={<Pause />}
              onClick={() => onTransition("suspend")}
              size="sm"
              variant="secondary"
            >
              <span className="whiteboard-action-label">
                {t("whiteboard.suspend")}
              </span>
            </Button>
          ) : null}
          {capabilities.can_resume ? (
            <Button
              className="whiteboard-action"
              data-tooltip={t("whiteboard.resume")}
              disabled={mutationPending}
              leadingIcon={<Play />}
              onClick={() => onTransition("resume")}
              size="sm"
            >
              <span className="whiteboard-action-label">
                {t("whiteboard.resume")}
              </span>
            </Button>
          ) : null}
          {capabilities.can_close ? (
            <Button
              className="whiteboard-action"
              data-tooltip={t("whiteboard.close")}
              disabled={mutationPending}
              leadingIcon={<Square />}
              onClick={() => onTransition("close")}
              size="sm"
              variant="danger"
            >
              <span className="whiteboard-action-label">
                {t("whiteboard.close")}
              </span>
            </Button>
          ) : null}
          <WhiteboardTrialDisclosure />
        </div>
      </header>
      {transitionError ? (
        <p className="whiteboard-tool-error" role="alert">
          {t("whiteboard.mutationError")}
        </p>
      ) : null}
      {document.status === "open" && capabilities.can_exchange_grant ? (
        <Suspense
          fallback={<WhiteboardState message={t("whiteboard.engineLoading")} />}
        >
          <LazyWhiteboardEngine
            actorID={actorID}
            capability={capabilities.capability}
            document={document}
            key={`${document.id}:${document.current_generation}:${document.revoke_generation}:${capabilities.capability}`}
            onRecoveryRequired={onRecoveryRequired}
            tenantID={tenantID}
          />
        </Suspense>
      ) : (
        <WhiteboardState message={t(`whiteboard.state.${document.status}`)} />
      )}
    </section>
  );
}

/** Compact, collapsed-by-default home for the Private Alpha guidance. */
function WhiteboardTrialDisclosure() {
  const { t } = useI18n();
  return (
    <details className="whiteboard-trial-disclosure">
      <summary
        className="whiteboard-action"
        data-tooltip={t("whiteboard.trialInfo")}
      >
        <Info aria-hidden="true" className="whiteboard-action-icon" />
        <span className="whiteboard-action-label">
          {t("whiteboard.trialInfo")}
        </span>
      </summary>
      <PrivateAlphaNotice />
    </details>
  );
}

function PrivateAlphaNotice() {
  const { t } = useI18n();

  return (
    <aside
      aria-labelledby="whiteboard-private-alpha-title"
      className="whiteboard-private-alpha-notice"
    >
      <div className="whiteboard-private-alpha-heading">
        <span className="whiteboard-private-alpha-badge">
          {t("whiteboard.privateAlpha.badge")}
        </span>
        <h3 id="whiteboard-private-alpha-title">
          {t("whiteboard.privateAlpha.title")}
        </h3>
      </div>
      <p>{t("whiteboard.privateAlpha.summary")}</p>
      <ul className="whiteboard-private-alpha-limits">
        <li>{t("whiteboard.privateAlpha.limits")}</li>
        <li>{t("whiteboard.privateAlpha.runtimeLimits")}</li>
        <li>{t("whiteboard.privateAlpha.accessibility")}</li>
        <li>{t("whiteboard.privateAlpha.dataCaution")}</li>
      </ul>
      <details className="whiteboard-private-alpha-quick-start">
        <summary>{t("whiteboard.privateAlpha.teacherQuickStart")}</summary>
        <ol>
          <li>{t("whiteboard.privateAlpha.teacherStepPrepare")}</li>
          <li>{t("whiteboard.privateAlpha.teacherStepPresent")}</li>
          <li>{t("whiteboard.privateAlpha.teacherStepFinish")}</li>
        </ol>
      </details>
      <a
        aria-label={t("whiteboard.privateAlpha.supportAria")}
        className="whiteboard-private-alpha-support"
        href={WHITEBOARD_PRIVATE_ALPHA_SUPPORT_HREF}
      >
        {t("whiteboard.privateAlpha.support")}
      </a>
    </aside>
  );
}

function WhiteboardState({
  alert = false,
  children,
  compactPrivateAlphaNotice = false,
  message,
  showPrivateAlphaNotice = false,
}: {
  alert?: boolean;
  children?: ReactNode;
  compactPrivateAlphaNotice?: boolean;
  message: string;
  showPrivateAlphaNotice?: boolean;
}) {
  return (
    <>
      {showPrivateAlphaNotice ? <PrivateAlphaNotice /> : null}
      {!showPrivateAlphaNotice && compactPrivateAlphaNotice ? (
        <div className="whiteboard-tool-state-disclosure">
          <WhiteboardTrialDisclosure />
        </div>
      ) : null}
      <div className="whiteboard-tool-state">
        <p
          aria-live={alert ? "assertive" : "polite"}
          role={alert ? "alert" : "status"}
        >
          {message}
        </p>
        {children}
      </div>
    </>
  );
}

function classifyWhiteboardError(
  error: Error,
): "error" | "featureOff" | "forbidden" {
  if (error instanceof APIRequestError) {
    if (error.status === 503) return "featureOff";
    if ([401, 403, 404].includes(error.status)) return "forbidden";
  }
  return "error";
}
