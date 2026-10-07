import { useEffect, useRef, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import { useDisplayNames } from "../../shared/ui/useDisplayNames";
import { openMediaPermissionTab } from "../../infrastructure/media/mediaPermissions";
import { useRegisterRefresh } from "../refresh/RefreshRegistryContext";
import { useStudyRoomSession, type Tile } from "../studyRoom/StudyRoomSessionContext";
import { useNudgeVaultItems } from "../nudgeVault/useNudgeVaultItems";
import { VideoBox } from "./ui/VideoBox";
import { ButtonLargeIcon } from "./ui/ButtonLargeIcon";
import { ButtonLarge } from "./ui/ButtonLarge";
import { Input } from "./ui/Input";

// The persistent, joined-room half of the study room UI, reading everything from the shared
// study-room session (useStudyRoomSession()). Mounted by AppFooter.tsx whenever `joinedRoom` is
// truthy, so it survives a tab switch (and an active study session) instead of unmounting the
// moment the Study tab isn't visible.
//
// Each tile is clickable, toggling selection. Selected tiles are the Nudge send targets below -
// there is no in-room producer-tag recording; a Nudge button plus a Nudge Vault picker sends the
// chosen vault item to every currently-selected tile instead.

// Video tiles are real React state (not a persistent ref-based DOM Map) so React's own
// reconciliation (keyed by participantIdentity) decides deterministically when each tile's
// container actually exists in the DOM - this tile's own effects below are race-free as a
// result: React never runs an effect before the element it targets has been committed.
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
    <VideoBox
      label={label}
      selected={selected}
      onClick={onToggle ?? undefined}
      data-participant={tile.participantIdentity}
    >
      <div ref={containerRef} className="study-room-panel__tile-media" />
    </VideoBox>
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

  // Resolves each participant's userId to their human_name (falling back to the raw id when no
  // profile/name exists) - see shared/ui/useDisplayNames.ts. Sourced from `participants` (the
  // authoritative "who's in the room" list), not `tiles` (a best-effort media view that can
  // briefly lag/differ).
  const displayName = useDisplayNames([...participants.keys()]);

  // The merge-and-sort of saved nudges is the shared useNudgeVaultItems() hook (also consumed
  // by FriendsBox.tsx/NudgeVaultBox.tsx) - see that hook's own header comment.
  const { items: vaultItems, loading: vaultLoading, error: vaultError, refresh: refreshVaultItems } =
    useNudgeVaultItems();
  const [selectedVaultKey, setSelectedVaultKey] = useState("");
  const [nudging, setNudging] = useState(false);
  const [nudgeError, setNudgeError] = useState<string | null>(null);

  // The Header's single Refresh button re-runs this fetch among every other currently-mounted
  // panel's own, so this footer doesn't render its own Refresh button.
  useRegisterRefresh(refreshVaultItems);

  // Targets selected participant tiles individually (NUDGE_SEND/PRODUCER_TAG_SEND_TO_FRIEND per
  // selected participant's userId), not the room-wide PRODUCER_TAG_SEND_TO_ROOM broadcast -
  // sending to "all the friends that were selected" is a subset of the room, not everyone in it.
  // This fires one existing per-target message per selection in a loop from the frontend, rather
  // than a new bulk-send message. A participant who isn't actually a friend of the sender has
  // their send rejected server-side (can_send_nudge()/producer_tag_sends' RLS) - surfaced here
  // the same way any other failed send in this codebase is, not specially handled.
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

  return (
    <div className="study-room-panel study-room-panel--footer">
      <header className="study-room-panel__header">
        <h2>{joinedRoom.name}</h2>
      </header>

      <div className="study-room-panel__call-options">
        <ButtonLargeIcon
          icon="microphone"
          enabled={micOn}
          onClick={toggleMic}
          aria-label={micOn ? "Turn mic off" : "Turn mic on"}
        />
        <ButtonLargeIcon
          icon="camera"
          enabled={cameraOn}
          onClick={toggleCamera}
          aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
        />
        <ButtonLarge onClick={() => void leaveRoom()} disabled={leaving}>
          {leaving ? "Leaving…" : "Leave Study Room"}
        </ButtonLarge>
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

      <div className="study-room-panel__grid">
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

      <section className="study-room-panel__nudge">
        {vaultError && <p role="alert">Couldn't load your Nudge Vault: {vaultError}.</p>}
        {vaultLoading && vaultItems.length === 0 && !vaultError && <p>Loading…</p>}
        {!vaultLoading && vaultItems.length === 0 && !vaultError && (
          <p>No saved nudges yet — add one from the Nudge Vault on the Friends tab.</p>
        )}
        <div className="study-room-panel__nudge-row">
          <ButtonLarge
            onClick={handleNudge}
            disabled={nudging || !selectedVaultKey || selectedParticipantIds.size === 0}
          >
            {nudging ? "Sending…" : `Nudge (${selectedParticipantIds.size} selected)`}
          </ButtonLarge>
          {vaultItems.length > 0 && (
            <Input
              variant="dropdown"
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
            </Input>
          )}
        </div>
        {nudgeError && <p role="alert">{nudgeError}</p>}
      </section>
    </div>
  );
}
