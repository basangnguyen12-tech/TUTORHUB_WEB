/**
 * MSG-WELCOME-3D-01: Zalo-PC-style welcome carousel for the empty right pane
 * of /app/messages (desktop only, loaded through React.lazy).
 *
 * Follows the WAI-ARIA APG carousel pattern: a labelled region, one group per
 * slide, a rotation control first in the tab order, previous/next buttons,
 * slide picker buttons with aria-current and ←/→ while focus is inside.
 * Rotation (6 s per slide) pauses on hover, when the tab is hidden or the
 * carousel is off screen, and stops for good when focus moves inside or the
 * user presses Pause; the same conditions pause the decorative motion
 * (WCAG 2.2.2). prefers-reduced-motion removes rotation and motion entirely.
 */
import type { TenantCapabilities } from "@tutorhub/api-client";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Link } from "react-router";
import { useI18n, type TranslationKey } from "../../app/i18n";
import type {
  TenantOperationAvailability,
  TenantOperationReason,
} from "../../app/tenantCapabilities";
import { useTiltParallax } from "./useTiltParallax";
import { WelcomeScene, type WelcomeSceneId } from "./welcomeScenes";
import "./MessagesWelcomeCarousel.css";

type TenantFeatures = TenantCapabilities["features"];
type Direction = 1 | -1;

interface WelcomeSlide {
  action: TranslationKey;
  body: TranslationKey;
  feature?: keyof TenantFeatures;
  id: WelcomeSceneId;
  title: TranslationKey;
  to?: string;
}

interface CarouselView {
  activeId: WelcomeSceneId;
  direction: Direction;
  previous: WelcomeSceneId | null;
  settled: boolean;
}

export const WELCOME_AUTOPLAY_MS = 6000;
const TRANSITION_MS = 1000;
const REDUCED_TRANSITION_MS = 160;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Only features that are live today; gated slides need their capability. */
const welcomeSlides: readonly WelcomeSlide[] = [
  {
    action: "conversations.createAction",
    body: "messagesWelcome.chatBody",
    id: "chat",
    title: "messagesWelcome.chatTitle",
  },
  {
    action: "messagesWelcome.roomAction",
    body: "messagesWelcome.roomBody",
    id: "room",
    title: "messagesWelcome.roomTitle",
    to: "/app/classrooms",
  },
  {
    action: "messagesWelcome.classesAction",
    body: "messagesWelcome.whiteboardBody",
    feature: "classroom_whiteboards",
    id: "whiteboard",
    title: "messagesWelcome.whiteboardTitle",
    to: "/app/classrooms",
  },
  {
    action: "messagesWelcome.classesAction",
    body: "messagesWelcome.filesBody",
    feature: "classroom_files_tool",
    id: "files",
    title: "messagesWelcome.filesTitle",
    to: "/app/classrooms",
  },
  {
    action: "messagesWelcome.calendarAction",
    body: "messagesWelcome.calendarBody",
    id: "calendar",
    title: "messagesWelcome.calendarTitle",
    to: "/app/calendar",
  },
  {
    action: "messagesWelcome.classesAction",
    body: "messagesWelcome.codeBody",
    feature: "classroom_code_tool",
    id: "code",
    title: "messagesWelcome.codeTitle",
    to: "/app/classrooms",
  },
];

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function reducedMotionSnapshot() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function pageHiddenSnapshot() {
  return document.hidden;
}

function serverFalse() {
  return false;
}

function reasonKey(reason: TenantOperationReason): TranslationKey {
  switch (reason) {
    case "feature_disabled":
      return "capabilities.reasonFeatureDisabled";
    case "quota_exhausted":
      return "capabilities.reasonQuotaExhausted";
    case "rate_limited":
      return "capabilities.reasonRateLimited";
    case "capabilities_loading":
      return "capabilities.reasonLoading";
    default:
      return "capabilities.reasonUnavailable";
  }
}

/** Renders `**bold**` spans from a translated sentence. */
function withEmphasis(text: string) {
  return text
    .split("**")
    .map((part, index) =>
      index % 2 === 1 ? (
        <strong key={index}>{part}</strong>
      ) : (
        <Fragment key={index}>{part}</Fragment>
      ),
    );
}

function indexOf(slides: readonly WelcomeSlide[], id: WelcomeSceneId) {
  return Math.max(
    0,
    slides.findIndex((slide) => slide.id === id),
  );
}

export interface MessagesWelcomeCarouselProps {
  /** Same availability that gates the header "Start a conversation" button. */
  createAvailability: TenantOperationAvailability;
  /** Tenant features; `undefined` while capabilities load or failed. */
  features: TenantFeatures | undefined;
  /** Opens the existing create-conversation dialog. */
  onStartConversation: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function MessagesWelcomeCarousel({
  createAvailability,
  features,
  onStartConversation,
}: MessagesWelcomeCarouselProps) {
  const { t } = useI18n();
  const slidesID = useId();
  const noteID = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<"dot" | "slide" | null>(null);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    reducedMotionSnapshot,
    serverFalse,
  );
  const pageHidden = useSyncExternalStore(
    subscribeVisibility,
    pageHiddenSnapshot,
    serverFalse,
  );
  const [rotationOn, setRotationOn] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const [view, setView] = useState<CarouselView>(() => ({
    activeId: "chat",
    direction: 1,
    previous: null,
    settled: reducedMotionSnapshot(),
  }));

  const slides = useMemo(
    () =>
      welcomeSlides.filter(
        (slide) =>
          !slide.feature || features?.[slide.feature]?.enabled === true,
      ),
    [features],
  );
  const total = slides.length;
  const activeIndex = indexOf(slides, view.activeId);
  const activeSlide = slides[activeIndex];
  const canRotate = !reducedMotion && total > 1;
  const rotating = canRotate && rotationOn;
  const playing = rotating && !hovered && !pageHidden && onScreen;
  const motionPaused = !rotationOn || hovered || pageHidden || !onScreen;

  const move = useCallback(
    (target: (index: number) => number, direction: Direction) => {
      setView((previous) => {
        const from = slides[indexOf(slides, previous.activeId)];
        const next =
          slides[
            (target(indexOf(slides, previous.activeId)) + slides.length) %
              slides.length
          ];
        if (!from || !next || next.id === from.id) {
          return previous;
        }
        return {
          activeId: next.id,
          direction,
          previous: from.id,
          settled: false,
        };
      });
    },
    [slides],
  );

  const goNext = useCallback(() => move((index) => index + 1, 1), [move]);
  const goPrevious = useCallback(() => move((index) => index - 1, -1), [move]);

  useTiltParallax(frameRef, !reducedMotion);

  // Finish the assemble / disperse transition, then drop the outgoing scene.
  useEffect(() => {
    if (view.settled) {
      return undefined;
    }
    const timer = window.setTimeout(
      () =>
        setView((previous) => ({ ...previous, previous: null, settled: true })),
      reducedMotion ? REDUCED_TRANSITION_MS : TRANSITION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [reducedMotion, view]);

  // One timeout per slide (never setInterval); re-armed on every change.
  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    const timer = window.setTimeout(goNext, WELCOME_AUTOPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [goNext, playing, view.activeId]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver !== "function") {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) {
          setOnScreen(entry.isIntersecting);
        }
      },
      { threshold: 0.2 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Keyboard changes keep focus on the matching dot or on the new slide.
  useEffect(() => {
    const intent = pendingFocus.current;
    pendingFocus.current = null;
    const root = rootRef.current;
    if (!intent || !root) {
      return;
    }
    const selector =
      intent === "dot"
        ? '.mw-dot[aria-current="true"]'
        : `[data-slide="${view.activeId}"]`;
    root.querySelector<HTMLElement>(selector)?.focus();
  }, [view.activeId]);

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    // APG: focus inside stops rotation until the user presses Play again;
    // focusing the rotation control itself does not.
    if ((event.target as EventTarget) !== toggleRef.current) {
      setRotationOn(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      total < 2
    ) {
      return;
    }
    event.preventDefault();
    const target = event.target instanceof Element ? event.target : null;
    pendingFocus.current = target?.closest(".mw-dot")
      ? "dot"
      : target?.closest(".mw-slide")
        ? "slide"
        : null;
    setRotationOn(false);
    if (event.key === "ArrowRight") {
      goNext();
    } else {
      goPrevious();
    }
  };

  const startConversation = (event: MouseEvent<HTMLButtonElement>) => {
    // Keep this slide (and its button) in place so the dialog can return
    // focus here when it closes.
    setRotationOn(false);
    onStartConversation(event);
  };

  if (!activeSlide) {
    return null;
  }

  return (
    <div
      aria-label={t("messagesWelcome.label")}
      aria-roledescription={t("messagesWelcome.carousel")}
      className="mw"
      data-motion={motionPaused ? "paused" : "running"}
      data-reduced-motion={reducedMotion ? "true" : undefined}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      ref={rootRef}
      role="region"
    >
      <div className="mw-frame" ref={frameRef}>
        {canRotate && (
          <button
            aria-label={t(
              rotationOn ? "messagesWelcome.pause" : "messagesWelcome.play",
            )}
            className="mw-toggle"
            onClick={() => setRotationOn((value) => !value)}
            ref={toggleRef}
            type="button"
          >
            {rotationOn ? (
              <Pause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
          </button>
        )}
        {total > 1 && (
          <button
            aria-controls={slidesID}
            aria-label={t("messagesWelcome.previous")}
            className="mw-arrow mw-arrow--previous"
            onClick={goPrevious}
            type="button"
          >
            <ChevronLeft aria-hidden="true" />
          </button>
        )}
        <div className="mw-viewport">
          <div aria-hidden="true" className="mw-glow" />
          <div
            aria-live={rotating ? "off" : "polite"}
            className="mw-slides"
            id={slidesID}
          >
            {slides.map((slide, index) => {
              const state =
                slide.id === activeSlide.id
                  ? view.settled
                    ? "active"
                    : "entering"
                  : slide.id === view.previous
                    ? "leaving"
                    : "hidden";
              const inactive = state === "leaving" || state === "hidden";
              const title = t(slide.title);
              const createBlocked =
                slide.id === "chat" && !createAvailability.available;
              return (
                <div
                  aria-hidden={inactive ? "true" : undefined}
                  aria-label={t("messagesWelcome.slideLabel", {
                    index: index + 1,
                    title,
                    total,
                  })}
                  aria-roledescription={t("messagesWelcome.slide")}
                  className="mw-slide"
                  data-slide={slide.id}
                  data-state={state}
                  inert={inactive}
                  key={slide.id}
                  role="group"
                  style={{ "--dir": String(view.direction) } as CSSProperties}
                  tabIndex={-1}
                >
                  <div className="mw-stage">
                    {state !== "hidden" && <WelcomeScene id={slide.id} />}
                  </div>
                  <div className="mw-copy">
                    <h3 className="mw-title">{title}</h3>
                    <p className="mw-body">{withEmphasis(t(slide.body))}</p>
                    {slide.to ? (
                      <Link className="mw-cta" to={slide.to}>
                        {t(slide.action)}
                      </Link>
                    ) : (
                      <button
                        aria-describedby={
                          createBlocked && !inactive ? noteID : undefined
                        }
                        className="mw-cta"
                        disabled={createBlocked}
                        onClick={startConversation}
                        type="button"
                      >
                        {t(slide.action)}
                      </button>
                    )}
                    {createBlocked && (
                      <p className="mw-note" id={inactive ? undefined : noteID}>
                        {t(reasonKey(createAvailability.reason))}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {total > 1 && (
          <button
            aria-controls={slidesID}
            aria-label={t("messagesWelcome.next")}
            className="mw-arrow mw-arrow--next"
            onClick={goNext}
            type="button"
          >
            <ChevronRight aria-hidden="true" />
          </button>
        )}
      </div>
      {total > 1 && (
        <div
          aria-label={t("messagesWelcome.picker")}
          className="mw-dots"
          role="group"
        >
          {slides.map((slide, index) => (
            <button
              aria-controls={slidesID}
              aria-current={index === activeIndex ? "true" : undefined}
              aria-label={t("messagesWelcome.goTo", {
                index: index + 1,
                title: t(slide.title),
              })}
              className="mw-dot"
              key={slide.id}
              onClick={() => move(() => index, index >= activeIndex ? 1 : -1)}
              type="button"
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default MessagesWelcomeCarousel;
