const RULE_ID_BASE = 1000;

export async function syncHardBlockRules(hardRestrictedHostnames: string[]): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const existingIds = existing.map((rule) => rule.id);

  const newRules: chrome.declarativeNetRequest.Rule[] = hardRestrictedHostnames.map(
    (hostname, index) => ({
      id: RULE_ID_BASE + index,
      priority: 1,
      action: {
        type: "redirect" as chrome.declarativeNetRequest.RuleActionType,
        redirect: { extensionPath: `/locked.html?site=${encodeURIComponent(hostname)}` },
      },
      condition: {
        requestDomains: [hostname],
        resourceTypes: ["main_frame" as chrome.declarativeNetRequest.ResourceType],
      },
    })
  );

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingIds,
    addRules: newRules,
  });
}

export async function clearHardBlockRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
  });
}

// syncHardBlockRules assigns rule IDs by array index into the hostname list at SESSION_START
// time and is never called again mid-session, so recomputing "the index for this hostname" here
// would be unreliable (the in-session hostname list this function's caller has access to may not
// match the array that originally produced the IDs). Looking the rule up by its own
// condition.requestDomains match is the reliable way to target exactly one hostname's rule
// without touching any other still-blocking rule.
export async function unlockHardBlockRuleForHostname(hostname: string): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const match = existing.find((rule) => rule.condition.requestDomains?.includes(hostname));
  if (!match) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [match.id] });
}

// v2 Task 12: the inverse of unlockHardBlockRuleForHostname above - re-adds a single hostname's
// redirect rule once a temp-passcode-unlocked window expires (alarmHandlers.ts's
// handleTempUnlockRelockAlarm, fired by alarmsApi.ts's scheduleTempUnlockRelockAlarm). This is
// what actually makes a temp-passcode unlock time-boxed rather than permanent: nothing else
// re-adds a hostname's DNR rule once removed (unlockHardBlockRuleForHostname's own comment notes
// its removal already lasts "for the rest of the session").
//
// Deliberately does NOT reuse syncHardBlockRules's RULE_ID_BASE + index scheme above - that
// scheme is only valid at initial session-start sync time (ids assigned by array index into that
// one call's hostname list, all at once). Reusing it here risks a real id collision: the rule set
// may have changed shape since session start (other hostnames unlocked/relocked in the meantime),
// so "the index this hostname originally had" is not a reliable id to reclaim. Instead, this scans
// currently-existing dynamic rule ids and picks the lowest currently-unused id at or above
// RULE_ID_BASE - a plain "find a free id" allocator, safe regardless of what else has happened to
// the rule set since.
export async function lockHardBlockRuleForHostname(hostname: string): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();

  // Idempotent - if a rule for this hostname already exists (e.g. this function runs twice, or
  // the hostname was never actually unlocked in the first place), don't add a duplicate.
  if (existing.some((rule) => rule.condition.requestDomains?.includes(hostname))) return;

  const usedIds = new Set(existing.map((rule) => rule.id));
  let id = RULE_ID_BASE;
  while (usedIds.has(id)) id++;

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "redirect" as chrome.declarativeNetRequest.RuleActionType,
          redirect: { extensionPath: `/locked.html?site=${encodeURIComponent(hostname)}` },
        },
        condition: {
          requestDomains: [hostname],
          resourceTypes: ["main_frame" as chrome.declarativeNetRequest.ResourceType],
        },
      },
    ],
  });
}
