// @vitest-environment jsdom

import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  APIRequestError,
  type WhiteboardToolProjection,
} from "@tutorhub/api-client";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWhiteboardTool, whiteboardToolPollInterval } from "./whiteboards";

const apiMocks = vi.hoisted(() => ({
  resolveWhiteboard: vi.fn(),
}));

vi.mock("@tutorhub/api-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tutorhub/api-client")>();
  return {
    ...original,
    resolveWhiteboard: apiMocks.resolveWhiteboard,
  };
});

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const mediaSpaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const emptyProjection: WhiteboardToolProjection = {
  can_create: false,
  document: null,
};

function problem(status: number) {
  return new APIRequestError(status, {
    type: `urn:tutorhub:problem:http-${status}`,
    title: "Whiteboard unavailable",
    status,
  });
}

function renderTool(pollIntervalMs?: number, enabled = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(
    () =>
      useWhiteboardTool(
        tenantID,
        mediaSpaceID,
        enabled,
        pollIntervalMs === undefined ? undefined : { pollIntervalMs },
      ),
    { wrapper },
  );
}

async function settle(ms: number) {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

describe("whiteboardToolPollInterval", () => {
  it("polls only for a positive requested interval", () => {
    expect(whiteboardToolPollInterval(undefined, null)).toBe(false);
    expect(whiteboardToolPollInterval(0, null)).toBe(false);
    expect(whiteboardToolPollInterval(-1, null)).toBe(false);
    expect(whiteboardToolPollInterval(Number.NaN, null)).toBe(false);
    expect(whiteboardToolPollInterval(4_000, null)).toBe(4_000);
  });

  it.each([401, 403, 404, 503])("stops after a terminal %i", (status) => {
    expect(whiteboardToolPollInterval(4_000, problem(status))).toBe(false);
  });

  it.each([429, 500, 502])("keeps polling after a transient %i", (status) => {
    expect(whiteboardToolPollInterval(4_000, problem(status))).toBe(4_000);
  });

  it("keeps polling after a network failure", () => {
    expect(
      whiteboardToolPollInterval(4_000, new TypeError("Failed to fetch")),
    ).toBe(4_000);
  });
});

describe("useWhiteboardTool polling", () => {
  beforeEach(() => {
    focusManager.setFocused(true);
    apiMocks.resolveWhiteboard.mockResolvedValue(emptyProjection);
  });

  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    apiMocks.resolveWhiteboard.mockReset();
  });

  it("keeps the default one-shot read without a poll interval", async () => {
    const { result } = renderTool();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await settle(80);

    expect(apiMocks.resolveWhiteboard).toHaveBeenCalledTimes(1);
    expect(apiMocks.resolveWhiteboard).toHaveBeenCalledWith(
      tenantID,
      mediaSpaceID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not read the projection while disabled", async () => {
    renderTool(10, false);
    await settle(60);

    expect(apiMocks.resolveWhiteboard).not.toHaveBeenCalled();
  });

  it("re-reads the projection on the requested interval", async () => {
    renderTool(10);

    await waitFor(() =>
      expect(apiMocks.resolveWhiteboard.mock.calls.length).toBeGreaterThan(2),
    );
  });

  it("does not poll while the tab is hidden", async () => {
    focusManager.setFocused(false);
    const { result } = renderTool(10);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await settle(80);

    expect(apiMocks.resolveWhiteboard).toHaveBeenCalledTimes(1);
  });

  it("stops polling after a terminal 403", async () => {
    apiMocks.resolveWhiteboard
      .mockResolvedValueOnce(emptyProjection)
      .mockRejectedValue(problem(403));
    const { result } = renderTool(10);

    await waitFor(() => expect(result.current.isError).toBe(true));
    const callsAtError = apiMocks.resolveWhiteboard.mock.calls.length;
    await settle(80);

    // 4xx is never retried, so the failed poll is the last request.
    expect(callsAtError).toBe(2);
    expect(apiMocks.resolveWhiteboard).toHaveBeenCalledTimes(callsAtError);
  });

  it("stops polling after a terminal 503 once its single retry fails", async () => {
    apiMocks.resolveWhiteboard.mockRejectedValue(problem(503));
    const { result } = renderTool(10);

    await waitFor(() => expect(result.current.isError).toBe(true));
    const callsAtError = apiMocks.resolveWhiteboard.mock.calls.length;
    await settle(80);

    expect(callsAtError).toBe(2);
    expect(apiMocks.resolveWhiteboard).toHaveBeenCalledTimes(callsAtError);
  });
});
