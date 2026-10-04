// The atlas state lives in the address bar (see urlState.ts), but browsers cap history.replaceState:
// Safari throws a SecurityError past 100 calls in 10 seconds, and dragging the relevance bar changes
// the state on every frame. So the address is written at most every 300 ms, always ending on the
// latest state, and a refused write never breaks the page.
import { useEffect, useRef } from "react";

const GAP_MS = 300;

export function useAddressBar(query: string): void {
  const latest = useRef(query);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrite = useRef(0);

  useEffect(() => {
    latest.current = query;
    // A write is already waiting: it will pick up this state.
    if (timer.current !== null) return;
    const write = () => {
      timer.current = null;
      const next = latest.current;
      if (next === window.location.search) return;
      lastWrite.current = Date.now();
      try {
        window.history.replaceState(null, "", `${window.location.pathname}${next}`);
      } catch {
        // Still refused (another script used up the browser's budget): the next change tries again.
      }
    };
    const wait = lastWrite.current + GAP_MS - Date.now();
    if (wait <= 0) write();
    else timer.current = setTimeout(write, wait);
  }, [query]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
}
