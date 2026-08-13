import { vi } from "vitest";

// The installed @webext-core/fake-browser version has no working chrome.idle
// implementation: setDetectionInterval/onStateChanged fall through to the scaffold's
// notMockedFunction() and throw synchronously. Stub a minimal implementation that tracks
// the registered onStateChanged listener so tests can invoke it directly, matching the
// shape idleHandlers.ts relies on. Same root cause as the chrome.permissions/
// declarativeNetRequest/scripting gaps already hand-stubbed in this codebase.
// `${chrome.idle.IdleState}` (not the bare enum type) matches what the real API's callback
// actually receives at runtime - see idleHandlers.ts's own comment on this for why.
type IdleStateValue = `${chrome.idle.IdleState}`;

export function createFakeIdle() {
  let listener: ((state: IdleStateValue) => void) | undefined;
  return {
    setDetectionInterval: vi.fn(),
    onStateChanged: {
      addListener: vi.fn((cb: (state: IdleStateValue) => void) => {
        listener = cb;
      }),
    },
    __emit(state: IdleStateValue) {
      listener?.(state);
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
