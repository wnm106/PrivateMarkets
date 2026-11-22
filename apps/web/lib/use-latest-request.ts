'use client';

import { useEffect, useMemo, useRef } from 'react';

/**
 * Keeps only the newest of a component's loads.
 *
 * A tab that reloads when the fund, the deal, or the user's As Of or Knowledge
 * date changes can have two loads in flight. Without this, whichever answers
 * last wins: a slow answer for the previous fund or date overwrites the new
 * one, and that stale data is what the tab shows and publishes to the
 * assistant.
 *
 *   const latest = useLatestRequest();
 *   const load = useCallback(async () => {
 *     const request = latest.begin();
 *     const result = await graphqlQuery(QUERY, vars, 'network-only', request.signal);
 *     if (!request.current(result)) return;
 *     ...
 *   }, [latest, ...]);
 *
 * `begin` aborts the load before it. `current` is false once a newer load has
 * begun, the request was aborted, or the component has unmounted.
 */
export function useLatestRequest() {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => () => ref.current?.abort(), []);
  return useMemo(
    () => ({
      begin() {
        ref.current?.abort();
        const controller = new AbortController();
        ref.current = controller;
        return {
          signal: controller.signal,
          current: (result?: { aborted?: boolean }) =>
            !result?.aborted && !controller.signal.aborted && ref.current === controller,
        };
      },
    }),
    [],
  );
}
