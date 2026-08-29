import { createContext, useContext, useEffect, useRef, useCallback, type ReactNode } from "react";

// v4.1 Task 2: replaces every panel's own Refresh button with one in Header.tsx that re-runs
// every currently-mounted panel's own fetch. A panel registers its fetch function via
// useRegisterRefresh() while it's mounted; Header's one button calls useRefreshAll(), which
// invokes every function still in the set. Unmounted panels unregister themselves (the
// useEffect cleanup below), so refreshAll() never touches a stale closure on a tab the user has
// since navigated away from.
interface RefreshRegistryValue {
  register(fn: () => void): () => void; // returns an unregister function
  refreshAll(): void;
}

const RefreshRegistryContext = createContext<RefreshRegistryValue | null>(null);

export function RefreshRegistryProvider({ children }: { children: ReactNode }) {
  const refreshersRef = useRef(new Set<() => void>());

  const register = useCallback((fn: () => void) => {
    refreshersRef.current.add(fn);
    return () => refreshersRef.current.delete(fn);
  }, []);

  const refreshAll = useCallback(() => {
    for (const fn of refreshersRef.current) fn();
  }, []);

  return (
    <RefreshRegistryContext.Provider value={{ register, refreshAll }}>
      {children}
    </RefreshRegistryContext.Provider>
  );
}

// Registers `fn` for as long as the calling component is mounted - only currently-visible
// panels are ever in the set, so refreshAll() never touches an unmounted tab's stale closure.
// `fn` itself should be stable (useCallback) in the caller, same contract useEffect deps already
// expect - an unstable fn just means slightly more churn in the registered set, not a bug.
export function useRegisterRefresh(fn: () => void): void {
  const ctx = useContext(RefreshRegistryContext);
  useEffect(() => {
    if (!ctx) return;
    return ctx.register(fn);
  }, [ctx, fn]);
}

export function useRefreshAll(): () => void {
  const ctx = useContext(RefreshRegistryContext);
  if (!ctx) throw new Error("useRefreshAll must be used within a RefreshRegistryProvider");
  return ctx.refreshAll;
}
