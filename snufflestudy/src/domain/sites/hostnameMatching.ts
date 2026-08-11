export function isHostnameInList(hostname: string, list: string[]): boolean {
  return list.some((site) => hostname === site || hostname.endsWith(`.${site}`));
}
