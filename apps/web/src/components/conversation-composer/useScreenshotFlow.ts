import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  captureScreenFrame,
  isCaptureCancellation,
  isCaptureShortcut,
  type ScreenCaptureMode,
} from "./screenCapture";

export type ScreenshotPhase = "idle" | "picking" | "countdown" | "editing";

function releaseCanvas(canvas: HTMLCanvasElement | null) {
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export interface ScreenshotFlowOptions {
  /** Dismissed picker or denied permission (announced politely). */
  onCancelled: () => void;
  /** The cropped screenshot, ready for the staged-upload path. */
  onFile: (file: File) => void;
  capture?: typeof captureScreenFrame;
}

/**
 * MSG-COMPOSER-TOOLS-01: capture → (countdown) → crop editor → File.
 * Every path that leaves the flow releases the captured canvas.
 */
export function useScreenshotFlow({
  capture = captureScreenFrame,
  onCancelled,
  onFile,
}: ScreenshotFlowOptions) {
  const [phase, setPhase] = useState<ScreenshotPhase>("idle");
  const [countdown, setCountdown] = useState(0);
  const [frame, setFrame] = useState<HTMLCanvasElement | null>(null);
  const [failedMode, setFailedMode] = useState<ScreenCaptureMode | null>(null);
  const phaseRef = useRef<ScreenshotPhase>("idle");
  const controller = useRef<AbortController | null>(null);
  const lastMode = useRef<ScreenCaptureMode>("screen");
  const mounted = useRef(true);
  const callbacks = useRef({ onCancelled, onFile });

  useLayoutEffect(() => {
    callbacks.current = { onCancelled, onFile };
  });

  const enter = (next: ScreenshotPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const start = useCallback(
    (mode: ScreenCaptureMode) => {
      if (phaseRef.current !== "idle") return;
      lastMode.current = mode;
      setFailedMode(null);
      const abort = new AbortController();
      controller.current = abort;
      enter("picking");
      capture({
        mode,
        onCountdown: (remaining) => {
          if (!mounted.current) return;
          enter("countdown");
          setCountdown(remaining);
        },
        signal: abort.signal,
      })
        .then((canvas) => {
          if (!mounted.current || abort.signal.aborted) {
            releaseCanvas(canvas);
            return;
          }
          setFrame(canvas);
          enter("editing");
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          enter("idle");
          if (isCaptureCancellation(error)) {
            callbacks.current.onCancelled();
          } else {
            setFailedMode(mode);
          }
        })
        .finally(() => {
          setCountdown(0);
          if (controller.current === abort) controller.current = null;
        });
    },
    [capture],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const closeEditor = () => {
    releaseCanvas(frame);
    setFrame(null);
    enter("idle");
  };

  return {
    cancelCountdown: () => controller.current?.abort(),
    countdown,
    dismissFailure: () => setFailedMode(null),
    failedMode,
    frame,
    phase,
    start,
    cancelEditor: closeEditor,
    confirm: (file: File) => {
      closeEditor();
      callbacks.current.onFile(file);
    },
    retake: () => {
      closeEditor();
      start(lastMode.current);
    },
  };
}

/** Listens for Ctrl+Alt+X while enabled and no modal dialog is open. */
export function useCaptureShortcut(enabled: boolean, onTrigger: () => void) {
  const handler = useRef(onTrigger);
  useLayoutEffect(() => {
    handler.current = onTrigger;
  });
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isCaptureShortcut(event)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      handler.current();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [enabled]);
}
