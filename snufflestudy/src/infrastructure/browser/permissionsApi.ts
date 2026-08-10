export async function hasDetailedTrackingPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ["*://*/*"] });
}

export async function requestDetailedTrackingPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: ["*://*/*"] });
}

export async function revokeDetailedTrackingPermission(): Promise<boolean> {
  return chrome.permissions.remove({ origins: ["*://*/*"] });
}

export async function requestHardBlockHostPermission(hostname: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [`*://${hostname}/*`, `*://*.${hostname}/*`] });
}
