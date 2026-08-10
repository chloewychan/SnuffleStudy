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
