import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type Ref,
} from "react";
import {
  paintPaper,
  type PaperViewport,
  type WhiteboardPaperMode,
} from "./whiteboardPaper";

export interface WhiteboardPaperBackdropHandle {
  /**
   * Called from Excalidraw's `onScrollChange` on every pan/zoom frame. It only
   * schedules one canvas paint per animation frame — never a React render.
   */
  setViewport(viewport: PaperViewport): void;
}

/**
 * Paper surface painted under a transparent Excalidraw canvas. Decorative
 * (`aria-hidden`), ignores pointer input and stays anchored to the scene.
 */
export function WhiteboardPaperBackdrop({
  dark,
  mode,
  viewportRef,
}: {
  dark: boolean;
  mode: WhiteboardPaperMode;
  viewportRef?: Ref<WhiteboardPaperBackdropHandle>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportStateRef = useRef<PaperViewport>({
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
  });
  const paperRef = useRef({ dark, mode });
  const frameRef = useRef<number | null>(null);
  const sizeRef = useRef({ dpr: 1, height: 0, width: 0 });

  const paintRef = useRef(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const { dpr, height, width } = sizeRef.current;
    if (canvas === null || width <= 0 || height <= 0) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    paintPaper(context, {
      ...viewportStateRef.current,
      ...paperRef.current,
      dpr,
      height,
      width,
    });
  });

  const scheduleRef = useRef(() => {
    if (frameRef.current !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      paintRef.current();
      return;
    }
    frameRef.current = requestAnimationFrame(() => paintRef.current());
  });

  useImperativeHandle(
    viewportRef,
    () => ({
      setViewport(viewport) {
        const current = viewportStateRef.current;
        if (
          current.scrollX === viewport.scrollX &&
          current.scrollY === viewport.scrollY &&
          current.zoom === viewport.zoom
        ) {
          return;
        }
        viewportStateRef.current = {
          scrollX: viewport.scrollX,
          scrollY: viewport.scrollY,
          zoom: viewport.zoom,
        };
        scheduleRef.current();
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    paperRef.current = { dark, mode };
    scheduleRef.current();
  }, [dark, mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const resize = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
      const deviceWidth = Math.max(1, Math.round(width * dpr));
      const deviceHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== deviceWidth) canvas.width = deviceWidth;
      if (canvas.height !== deviceHeight) canvas.height = deviceHeight;
      sizeRef.current = { dpr, height, width };
      // Resizing clears the bitmap: repaint synchronously to avoid a flash.
      if (
        frameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(frameRef.current);
      }
      paintRef.current();
    };
    resize();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    // Moving the window between monitors changes the device pixel ratio.
    const ratioQuery =
      typeof matchMedia === "function"
        ? matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`)
        : null;
    ratioQuery?.addEventListener?.("change", resize);
    return () => {
      observer?.disconnect();
      ratioQuery?.removeEventListener?.("change", resize);
      if (
        frameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = null;
    };
  }, []);

  return (
    <canvas
      aria-hidden="true"
      className="whiteboard-paper-backdrop"
      data-paper-dark={dark ? "true" : "false"}
      data-paper-mode={mode}
      data-testid="whiteboard-paper-backdrop"
      ref={canvasRef}
    />
  );
}
