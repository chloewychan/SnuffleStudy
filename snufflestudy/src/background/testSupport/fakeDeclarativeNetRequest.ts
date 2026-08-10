import { vi } from "vitest";

// The installed @webext-core/fake-browser version has no working
// chrome.declarativeNetRequest implementation: getDynamicRules/updateDynamicRules
// fall through to the scaffold's notMockedFunction() and throw synchronously.
// Stub a minimal in-memory implementation that tracks dynamic rules across calls,
// matching the shape syncHardBlockRules/clearHardBlockRules rely on.
// Same root cause as the chrome.permissions gap Task 12 hand-stubbed.
export function createFakeDeclarativeNetRequest() {
  let rules: chrome.declarativeNetRequest.Rule[] = [];
  return {
    getDynamicRules: vi.fn(async () => rules),
    updateDynamicRules: vi.fn(
      async (opts: {
        removeRuleIds?: number[];
        addRules?: chrome.declarativeNetRequest.Rule[];
      }) => {
        const removeIds = new Set(opts.removeRuleIds ?? []);
        rules = rules.filter((r) => !removeIds.has(r.id));
        rules = [...rules, ...(opts.addRules ?? [])];
      },
    ),
  };
}

// Applies the stub on top of the real `chrome` global. Call after
// `fakeBrowser.reset()` in each test file's `beforeEach` — reset() doesn't
// touch this stub, so it must be reapplied every test to get a clean rule set.
export function stubFakeDeclarativeNetRequest(): void {
  vi.stubGlobal("chrome", { ...chrome, declarativeNetRequest: createFakeDeclarativeNetRequest() });
}
