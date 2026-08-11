export async function hasDetailedTrackingPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ["*://*/*"] });
}

export async function requestDetailedTrackingPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: ["*://*/*"] });
}

export async function revokeDetailedTrackingPermission(): Promise<boolean> {
  return chrome.permissions.remove({ origins: ["*://*/*"] });
}

export async function requestHardBlockHostPermission(hostnames: string[]): Promise<boolean> {
  if (hostnames.length === 0) return true;
  const origins = hostnames.flatMap((hostname) => [`*://${hostname}/*`, `*://*.${hostname}/*`]);
  return chrome.permissions.request({ origins });
}
