import { useLayoutEffect, useRef } from "react";

export interface ChatPageRequest {
  readonly sequence: number;
  readonly page: number;
  readonly onHandled: () => void;
}

/** A consumed reference must never replay on a reconnect or when follow lock lifts. */
export function useChatPageRequest(
  request: ChatPageRequest | null | undefined,
  ready: boolean,
  locked: boolean,
  manual: () => void,
  scroll: (page: number) => void,
) {
  const consumed = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!request || !ready || consumed.current === request.sequence) return;
    consumed.current = request.sequence;
    if (!locked) {
      manual();
      scroll(request.page);
    }
    request.onHandled();
  }, [request, ready, locked, manual, scroll]);
}
