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
