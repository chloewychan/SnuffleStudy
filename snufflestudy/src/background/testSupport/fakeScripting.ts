import { vi } from "vitest";

// The installed @webext-core/fake-browser version has no working chrome.scripting
// implementation: getRegisteredContentScripts/registerContentScripts/unregisterContentScripts
// all fall through to the scaffold's notMockedFunction() and throw synchronously.
// Stub a minimal in-memory implementation that tracks registered content scripts by id across
// calls, matching the shape registerOverlayContentScript/unregisterOverlayContentScript rely
// on. Same root cause as the chrome.permissions gap (Task 12) and chrome.declarativeNetRequest
// gap (Task 13), both already hand-stubbed in this codebase — see fakeDeclarativeNetRequest.ts.
export function createFakeScripting() {
  let registered: chrome.scripting.RegisteredContentScript[] = [];
  return {
    getRegisteredContentScripts: vi.fn(
      async (filter?: chrome.scripting.ContentScriptFilter) => {
        if (!filter?.ids) return registered;
        const ids = new Set(filter.ids);
        return registered.filter((script) => ids.has(script.id));
      },
    ),
    registerContentScripts: vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => {
      registered = [...registered, ...scripts];
    }),
    unregisterContentScripts: vi.fn(async (filter?: chrome.scripting.ContentScriptFilter) => {
      if (!filter?.ids) {
        registered = [];
        return;
      }
      const ids = new Set(filter.ids);
      registered = registered.filter((script) => !ids.has(script.id));
    }),
  };
}

// Applies the stub on top of the real `chrome` global. Call after `fakeBrowser.reset()` in
// each test file's `beforeEach` — reset() doesn't touch this stub, so it must be reapplied
// every test to get a clean registration set.
export function stubFakeScripting(): void {
  vi.stubGlobal("chrome", { ...chrome, scripting: createFakeScripting() });
}
