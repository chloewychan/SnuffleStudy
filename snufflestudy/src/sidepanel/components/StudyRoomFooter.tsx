import { useEffect, useRef, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";
import { openMediaPermissionTab } from "../../infrastructure/media/mediaPermissions";
import { useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { useStudyRoomSession, type Tile } from "../studyRoom/StudyRoomSessionContext";
import { useNudgeVaultItems } from "../nudgeVault/useNudgeVaultItems";
import TextSmall from "../ui/TextSmall";
import footerStyles from "../styles/frontend-backup/pages/footers/StudyRoomFooter.module.css";
import callPanelStyles from "../styles/frontend-backup/components/study/StudyRoomCallPanel.module.css";
import videoBoxStyles from "../styles/frontend-backup/components/study/VideoBox.module.css";

// v4.1 Task 7: the persistent, joined-room half of the old StudyRoomPanel.tsx, now reading
// everything from the shared study-room session (useStudyRoomSession()) instead of local state -
// mounted by AppFooter.tsx whenever `joinedRoom` is truthy, so it survives a tab switch (and an
// active study session) instead of unmounting the moment the Study tab isn't visible.
//
// Three changes from the old joined-room branch (scope doc: "Other Pages — Study Session -
// Study Room footer"):
// (1) the plain participant-name list (`study-room-panel__presence`) is removed entirely - every
//     participant already has a tile.
// (2) each tile is now clickable, toggling selection (a brand-new interaction - tiles used to be
//     display-only).
// (3) in-room producer-tag recording is removed entirely (not relocated - Decision 9 leaves the
//     room-broadcast backend in place, unused). One Nudge button + a Nudge Vault picker replaces
//     it, sending the chosen vault item to every currently-selected tile.
//
// v4.2 Task 6: re-skinned as frontend-backup's StudyRoomFooter.tsx/StudyRoomCallPanel.tsx/
// VideoBox.tsx design. Per Task 1's own scaffolding convention, VideoBox/StudyRoomCallPanel never
// got ported as separate component files (only their CSS Modules did) - their markup is grafted
// in here directly, same as every other v4.2 task's "remaining" (non-primitive) frontend-backup
// components. StudyRoomVideoTile below IS this file's VideoBox usage - not a new file.

// QA-discovered bug precedent (v3.3 QA pass), preserved verbatim from StudyRoomPanel.tsx: video
// tiles are real React state (not a persistent ref-based DOM Map) so React's own reconciliation
// (keyed by participantIdentity) decides deterministically when each tile's container actually
// exists in the DOM - this tile's own effects below are race-free as a result: React never runs an
// effect before the element it targets has been committed.
function StudyRoomVideoTile({
  tile,
  label,
  selected,
  onToggle,
}: {
  tile: Tile;
  label: string;
  selected: boolean;
  // null for the local ("You") tile - nudging yourself isn't a real send target
  // (can_send_nudge()/can_send_producer_tag_dm() would reject it, since you can't be your own
  // friend), so it's made genuinely non-interactive rather than merely visually discouraged: no
  // role/tabIndex/click-or-keyboard handler at all, not just a no-op onClick.
  onToggle: (() => void) | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const element = tile.videoElement;
    if (!container || !element) return;
    container.appendChild(element);
    return () => {
      element.remove();
    };
  }, [tile.videoElement]);

  useEffect(() => {
    const container = containerRef.current;
    const element = tile.audioElement;
    if (!container || !element) return;
    container.appendChild(element);
    return () => {
      element.remove();
    };
  }, [tile.audioElement]);

  return (
    <div
      ref={containerRef}
      className={videoBoxStyles.videoBox}
      // v4.2 Task 6: VideoBox.tsx's own `property1` variant prop ("default"/"selected") - its
      // source CSS module has no visual rule for "selected" at all (a static mockup never needed
      // one), so this task adds one (see VideoBox.module.css) rather than leaving the toggle
      // invisible.
      data-property1={selected ? "selected" : "default"}
      data-participant={tile.participantIdentity}
      {...(onToggle
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-pressed": selected,
            onClick: onToggle,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle();
              }
            },
          }
        : {})}
    >
      <TextSmall textbox={label} />
    </div>
  );
}

export function StudyRoomFooter() {
  const {
    joinedRoom,
    tiles,
    participants,
    cameraOn,
    micOn,
    mediaError,
    selectedParticipantIds,
    leaving,
    leaveRoom,
    toggleCamera,
    toggleMic,
    toggleParticipantSelected,
    clearParticipantSelection,
  } = useStudyRoomSession();

  // v3.3 Task 8: resolves each participant's userId to their human_name (falling back to the raw
  // id when no profile/name exists) - see shared/ui/useDisplayNames.ts. Sourced from `participants`
  // (the authoritative "who's in the room" list), not `tiles` (a best-effort media view that can
  // briefly lag/differ), same as the pre-split component.
  const displayName = useDisplayNames([...participants.keys()]);

  // v4.1 Task 9: the merge-and-sort this footer used to inline is now the shared
  // useNudgeVaultItems() hook (also consumed by FriendsBox.tsx/NudgeVaultBox.tsx) - see that
  // hook's own header comment.
  const { items: vaultItems, loading: vaultLoading, error: vaultError, refresh: refreshVaultItems } =
    useNudgeVaultItems();
  const [selectedVaultKey, setSelectedVaultKey] = useState("");
  const [nudging, setNudging] = useState(false);
  const [nudgeError, setNudgeError] = useState<string | null>(null);

  // v4.1 Task 2: replaces this footer's own Refresh button (it never had one of its own before
  // Task 7, but the Nudge Vault picker it owns needs one) - the Header's one Refresh button
  // re-runs this fetch among every other currently-mounted panel's own.
  useRegisterRefresh(refreshVaultItems);

  // Decision 8: targets selected participant tiles individually (NUDGE_SEND/
  // PRODUCER_TAG_SEND_TO_FRIEND per selected participant's userId), not the room-wide
  // PRODUCER_TAG_SEND_TO_ROOM broadcast - "sends a nudge to all the friends that were selected" is
  // a subset of the room, not everyone in it. Decision 7: one existing per-target message per
  // selection, fired in a loop from the frontend - no new bulk-send message. A participant who
  // isn't actually a friend of the sender has their send rejected server-side
  // (can_send_nudge()/producer_tag_sends' RLS) - surfaced here the same way any other failed send
  // in this codebase is, not specially handled.
  function handleNudge() {
    if (!selectedVaultKey || selectedParticipantIds.size === 0) return;
    const [kind, id] = selectedVaultKey.split(":", 2) as ["written" | "audio", string];
    setNudging(true);
    setNudgeError(null);
    const targets = [...selectedParticipantIds];

    Promise.all(
      targets.map((friendUserId) => {
        const send =
          kind === "written"
            ? sendMessage<{ ok: boolean; error?: string }>({
                type: "NUDGE_SEND",
                payload: { friendUserId, vaultTextId: id },
              })
            : sendMessage<{ ok: boolean; error?: string }>({
                type: "PRODUCER_TAG_SEND_TO_FRIEND",
                payload: { tagId: id, friendUserId },
              });
        // Each send is caught individually (not left to reject through Promise.all) - this
        // codebase's standing rule against a bare async call in a UI handler applies equally to a
        // loop of them: one recipient's rejection must not become an unhandled rejection, and must
        // not stop the others in the loop from being attempted.
        return send.catch((err) => {
          console.error("Failed to send a nudge from the study room footer", err);
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        });
      })
    )
      .then((results) => {
        const failed = results.find((r) => !r.ok);
        if (failed) {
          setNudgeError(failed.error ?? "Could not send that nudge to everyone selected.");
        }
      })
      .finally(() => {
        setNudging(false);
        clearParticipantSelection();
      });
  }

  if (!joinedRoom) return null;

  const nudgeAccessibleName = nudging
    ? "Sending…"
    : `Nudge (${selectedParticipantIds.size} selected)`;

  return (
    <div className={footerStyles.studyRoomFooter}>
      <h1 className={footerStyles.egStudyRoom}>{joinedRoom.name}</h1>

      <section className={callPanelStyles.studyRoomCallPanel}>
        <div className={callPanelStyles.callOptions}>
          <button
            type="button"
            className={callPanelStyles.buttonLargeIconReset}
            onClick={toggleMic}
            aria-pressed={micOn}
            aria-label="Microphone"
          >
            <img
              className={callPanelStyles.buttonLargeIcon}
              loading="lazy"
              alt=""
              src={chrome.runtime.getURL(
                micOn ? "sidepanel/assets/button-mic-on.svg" : "sidepanel/assets/button-mic-off@2x.png"
              )}
            />
          </button>
          <button
            type="button"
            className={callPanelStyles.buttonLargeIconReset}
            onClick={toggleCamera}
            aria-pressed={cameraOn}
            aria-label="Camera"
          >
            <img
              className={callPanelStyles.buttonLargeIcon}
              loading="lazy"
              alt=""
              src={chrome.runtime.getURL(
                cameraOn
                  ? "sidepanel/assets/button-camera-on.svg"
                  : "sidepanel/assets/button-camera-off@2x.png"
              )}
            />
          </button>
          <button
            type="button"
            className={callPanelStyles.buttonLarge}
            onClick={() => void leaveRoom()}
            disabled={leaving}
          >
            <h3 className={callPanelStyles.button}>{leaving ? "Leaving…" : "Leave Study Room"}</h3>
          </button>
        </div>

        {mediaError && (
          <p role="alert">
            {mediaError.message}
            {mediaError.actionable && (
              <>
                {" "}
                <button type="button" onClick={openMediaPermissionTab}>
                  Open a tab to grant access
                </button>
              </>
            )}
          </p>
        )}

        <div className={callPanelStyles.exampleListItems}>
          {tiles.map((tile) => (
            <StudyRoomVideoTile
              key={tile.participantIdentity}
              tile={tile}
              label={tile.isLocal ? "You" : displayName(tile.participantIdentity)}
              selected={selectedParticipantIds.has(tile.participantIdentity)}
              onToggle={
                tile.isLocal ? null : () => toggleParticipantSelected(tile.participantIdentity)
              }
            />
          ))}
        </div>

        <div className={callPanelStyles.buttonNudge}>
          <button
            type="button"
            className={callPanelStyles.buttonLarge}
            onClick={handleNudge}
            disabled={nudging || !selectedVaultKey || selectedParticipantIds.size === 0}
            aria-label={nudgeAccessibleName}
          >
            <h3 className={callPanelStyles.button}>{nudging ? "Sending…" : "Nudge"}</h3>
          </button>

          {vaultError && <p role="alert">Couldn't load your Nudge Vault: {vaultError}.</p>}
          {vaultLoading && vaultItems.length === 0 && !vaultError && <p>Loading…</p>}
          {!vaultLoading && vaultItems.length === 0 && !vaultError && (
            <p>No saved nudges yet — add one from the Nudge Vault on the Friends tab.</p>
          )}
          {vaultItems.length > 0 && (
            <div className={callPanelStyles.input}>
              <select
                className={callPanelStyles.dropdown}
                aria-label="Nudge Vault item"
                value={selectedVaultKey}
                onChange={(e) => setSelectedVaultKey(e.target.value)}
              >
                <option value="">Choose a saved nudge</option>
                {vaultItems.map((item) => (
                  <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>
                    {item.kind === "written"
                      ? item.body
                      : `Audio clip (${Math.round(item.durationMs / 1000)}s)`}
                  </option>
                ))}
              </select>
              <img
                className={callPanelStyles.vectorIcon}
                alt=""
                src={chrome.runtime.getURL("sidepanel/assets/icon-chevron-down.svg")}
              />
            </div>
          )}
        </div>
        {nudgeError && <p role="alert">{nudgeError}</p>}
      </section>
    </div>
  );
}
