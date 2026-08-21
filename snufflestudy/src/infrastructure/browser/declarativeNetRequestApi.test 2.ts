import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { stubFakeDeclarativeNetRequest } from "../../background/testSupport/fakeDeclarativeNetRequest";
import {
  syncHardBlockRules,
  clearHardBlockRules,
  unlockHardBlockRuleForHostname,
  lockHardBlockRuleForHostname,
} from "./declarativeNetRequestApi";

beforeEach(() => {
  fakeBrowser.reset();
  stubFakeDeclarativeNetRequest();
});

async function ruleFor(hostname: string) {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.find((rule) => rule.condition.requestDomains?.includes(hostname));
}

// v2 Task 12: lockHardBlockRuleForHostname is the inverse of unlockHardBlockRuleForHostname - the
// mechanism that makes a temp-passcode unlock time-boxed rather than permanent (see
// alarmHandlers.ts's handleTempUnlockRelockAlarm, which calls this once a temp-passcode's expiry
// alarm fires).
describe("lockHardBlockRuleForHostname", () => {
  it("adds a redirect-to-locked.html rule for the given hostname when none exists yet", async () => {
    await lockHardBlockRuleForHostname("youtube.com");

    const rule = await ruleFor("youtube.com");
    expect(rule).toBeDefined();
    expect(rule!.action.type).toBe("redirect");
    expect(rule!.action.redirect?.extensionPath).toBe(
      "/locked.html?site=youtube.com"
    );
    expect(rule!.condition.resourceTypes).toEqual(["main_frame"]);
  });

  it("round-trips with unlockHardBlockRuleForHostname - unlock removes it, lock re-adds it, blocking the same hostname again", async () => {
    await syncHardBlockRules(["youtube.com", "reddit.com"]);
    expect(await ruleFor("youtube.com")).toBeDefined();

    await unlockHardBlockRuleForHostname("youtube.com");
    expect(await ruleFor("youtube.com")).toBeUndefined();
    // The other hostname's rule is untouched by the unlock.
    expect(await ruleFor("reddit.com")).toBeDefined();

    await lockHardBlockRuleForHostname("youtube.com");
    expect(await ruleFor("youtube.com")).toBeDefined();
    expect(await ruleFor("reddit.com")).toBeDefined();
  });

  it("picks an id that doesn't collide with an existing rule's id, even at/above RULE_ID_BASE", async () => {
    await syncHardBlockRules(["a.com", "b.com", "c.com"]); // ids 1000, 1001, 1002
    await unlockHardBlockRuleForHostname("b.com"); // frees id 1001, 1000/1002 still in use

    await lockHardBlockRuleForHostname("d.com");

    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = rules.map((r) => r.id);
    // No duplicate ids - the new rule must have picked an id distinct from every surviving one.
    expect(new Set(ids).size).toBe(ids.length);
    expect(await ruleFor("a.com")).toBeDefined();
    expect(await ruleFor("c.com")).toBeDefined();
    expect(await ruleFor("d.com")).toBeDefined();
  });

  it("is idempotent - does not add a duplicate rule if one for the hostname already exists", async () => {
    await lockHardBlockRuleForHostname("youtube.com");
    const rulesAfterFirst = await chrome.declarativeNetRequest.getDynamicRules();

    await lockHardBlockRuleForHostname("youtube.com");
    const rulesAfterSecond = await chrome.declarativeNetRequest.getDynamicRules();

    expect(rulesAfterSecond.length).toBe(rulesAfterFirst.length);
    expect(rulesAfterSecond.filter((r) => r.condition.requestDomains?.includes("youtube.com"))).toHaveLength(1);
  });

  it("leaves other hostnames' rules untouched", async () => {
    await syncHardBlockRules(["youtube.com", "reddit.com"]);
    await unlockHardBlockRuleForHostname("youtube.com");

    await lockHardBlockRuleForHostname("youtube.com");

    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    expect(rules).toHaveLength(2);
  });
});

describe("declarativeNetRequestApi - existing v1/Task 8 functions (regression coverage for this file, which had no dedicated test file before Task 12)", () => {
  it("syncHardBlockRules installs one rule per hostname", async () => {
    await syncHardBlockRules(["youtube.com", "reddit.com"]);
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    expect(rules).toHaveLength(2);
  });

  it("clearHardBlockRules removes every dynamic rule", async () => {
    await syncHardBlockRules(["youtube.com", "reddit.com"]);
    await clearHardBlockRules();
    expect(await chrome.declarativeNetRequest.getDynamicRules()).toEqual([]);
  });

  it("unlockHardBlockRuleForHostname is a no-op when no rule exists for that hostname", async () => {
    await syncHardBlockRules(["youtube.com"]);
    await unlockHardBlockRuleForHostname("reddit.com");
    expect(await ruleFor("youtube.com")).toBeDefined();
  });
});
