import { useCallback, useEffect, useRef, useState } from "react";

export type Load<T> =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "loaded"; data: T };

/**
 * Loads data for a screen. `reload` keeps the current data on screen while
 * it fetches (no flash back to the skeleton); `set` replaces it with an
 * action's response.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const seq = useRef(0);
  const run = useCallback(
    async (keep: boolean) => {
      const n = ++seq.current;
      if (!keep) setState({ kind: "loading" });
      try {
        const data = await fn();
        if (n === seq.current) setState({ kind: "loaded", data });
        return data;
      } catch (error) {
        if (n === seq.current) setState({ kind: "error", error });
        throw error;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );
  useEffect(() => {
    run(false).catch(() => {});
  }, [run]);
  return {
    state,
    retry: () => run(false).catch(() => {}),
    reload: () => run(true),
    set: (data: T) => {
      seq.current++;
      setState({ kind: "loaded", data });
    },
  };
}
