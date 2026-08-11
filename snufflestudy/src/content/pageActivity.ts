export function onUserActivity(callback: () => void): () => void {
  const events = ["mousemove", "keydown", "scroll"] as const;
  events.forEach((event) => window.addEventListener(event, callback, { passive: true }));
  return () => events.forEach((event) => window.removeEventListener(event, callback));
}
