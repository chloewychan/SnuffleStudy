import { vi } from "vitest";

// The installed @webext-core/fake-browser version has no working chrome.idle
// implementation: setDetectionInterval/onStateChanged fall through to the scaffold's
// notMockedFunction() and throw synchronously. Stub a minimal implementation that tracks
// the registered onStateChanged listener(s) so tests can invoke them directly, matching the
// shape idleHandlers.ts (and infrastructure/idle/idleApi.ts) relies on. Same root cause as the
// chrome.permissions/declarativeNetRequest/scripting gaps already hand-stubbed in this codebase.
// `${chrome.idle.IdleState}` (not the bare enum type) matches what the real API's callback
// actually receives at runtime - see idleHandlers.ts's own comment on this for why.
type IdleStateValue = `${chrome.idle.IdleState}`;
type IdleListener = (state: IdleStateValue) => void;

// Tracks a list, not a single slot - idleHandlers.ts and idleApi.ts each register their own
// independent onStateChanged listener (real chrome.idle supports multiple listeners on the
// same event), so a single-slot stub would silently drop whichever registered first.
export function createFakeIdle() {
  const listeners: IdleListener[] = [];
  return {
    setDetectionInterval: vi.fn(),
    onStateChanged: {
      addListener: vi.fn((cb: IdleListener) => {
        listeners.push(cb);
      }),
      removeListener: vi.fn((cb: IdleListener) => {
        const index = listeners.indexOf(cb);
        if (index !== -1) listeners.splice(index, 1);
      }),
    },
    __emit(state: IdleStateValue) {
      for (const listener of [...listeners]) listener(state);
    },
  };
}

// Applies the stub on top of the real `chrome` global. Call after `fakeBrowser.reset()` in
// each test file's `beforeEach` — reset() doesn't touch this stub. Returns the fake so
// tests can call `__emit(state)` to simulate a chrome.idle.onStateChanged event.
export function stubFakeIdle(): ReturnType<typeof createFakeIdle> {
  const fake = createFakeIdle();
  vi.stubGlobal("chrome", { ...chrome, idle: fake });
  return fake;
}
