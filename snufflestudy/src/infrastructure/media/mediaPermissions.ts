// QA-discovered (v3.2 Task 9): Chrome's side panel is a documented platform limitation - it can
// never show the getUserMedia() permission prompt at all (confirmed against real-world reports,
// not assumed - see videoCallClient.ts's/audioRecorder.ts's callers, ProducerTagRecorder.tsx and
// StudyRoomPanel.tsx, for the two places this bites). Every call rejects with a NotAllowedError
// (message text like "Permission dismissed"), no dialog ever appears, and no decision is ever
// recorded - chrome://settings/content/camera|microphone stays empty no matter how many times
// this happens, so there is nothing there for a user to "reset." This isn't fixable from inside
// the panel; the one real path is requesting the SAME permission from a full extension tab once
// (which CAN show the dialog) - the grant is per-origin, not per-frame-context, so the side panel
// can then use it without prompting again.

export const MEDIA_PERMISSION_HELP_MESSAGE =
  "Camera/microphone access can't be requested from this panel - that's a Chrome limitation, " +
  "not a problem with your camera or mic. Grant it once from a full tab, then try again here.";

// True only for the specific browser rejection this module's callers know how to explain -
// NotAllowedError covers both an explicit block and a prompt that Chrome silently dismissed
// without ever displaying it. Deliberately NOT matched against NotFoundError/NotReadableError/
// OverconstrainedError (a genuinely missing or broken device) or any other failure, since
// suggesting "open a tab" for those would be actively misleading.
export function isMediaPermissionError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotAllowedError";
}

// Opens a full extension tab where getUserMedia() can actually prompt - options.html is used as
// a convenient existing full-page entrypoint (AccountPage.tsx's "Camera & microphone access"
// section is where the user actually grants it), not otherwise related to account settings.
export function openMediaPermissionTab(): void {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
}
