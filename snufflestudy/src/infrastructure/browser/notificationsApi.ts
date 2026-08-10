export function showNotification(id: string, title: string, message: string): void {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "/icons/128.png",
    title,
    message,
  });
}
