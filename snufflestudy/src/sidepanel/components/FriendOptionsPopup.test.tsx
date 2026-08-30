import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FriendOptionsPopup } from "./FriendOptionsPopup";
import type {
  FriendshipSettings,
  FriendshipSettingsPatch,
} from "../../infrastructure/backend/friendshipSettingsApi";

// v4.2 Task 9: FriendOptionsPopup replaces FriendsBox.tsx's old inline
// openOptionsForFriendId-driven expansion, built from frontend-backup's FriendDetailsPopup.tsx
// design (Decision 2). Unlike StudyRoomAccessPopup (Task 5), this component owns no fetching of
// its own - every piece of data it renders (settings, errors, busy state) is already loaded by
// FriendsBox.tsx and passed straight through as props, so this file exercises it purely via props
// and callbacks, no sendMessage mocking needed.

const sampleSettings: FriendshipSettings = {
  userId: "user-self",
  friendUserId: "user-friend",
  receiveLiveNudges: true,
  sendLiveNudges: true,
  receiveDailyDigest: true,
  nudgeCooldownSecondsWritten: 300,
  nudgeCooldownSecondsAudio: 300,
  shareDistractionAttempts: false,
  shareCurrentDomain: false,
  shareGoalText: false,
  shareInterventionCount: false,
  shareFullHistory: false,
};

function renderPopup(
  overrides: Partial<{
    friendId: string;
    friendName: string;
    settings: FriendshipSettings | undefined;
    settingsError: string | null;
    savingKey: string | null;
    saveError: string | null;
    onToggle: (friendId: string, field: keyof FriendshipSettingsPatch, checked: boolean) => void;
    onRemove: (friendId: string) => void;
    removing: boolean;
    removeError: string | null;
    onClose: () => void;
  }> = {}
) {
  const onToggle = overrides.onToggle ?? vi.fn();
  const onRemove = overrides.onRemove ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const utils = render(
    <FriendOptionsPopup
      friendId={overrides.friendId ?? "user-friend"}
      friendName={overrides.friendName ?? "Alex"}
      settings={"settings" in overrides ? overrides.settings : sampleSettings}
      settingsError={overrides.settingsError ?? null}
      savingKey={overrides.savingKey ?? null}
      saveError={overrides.saveError ?? null}
      onToggle={onToggle}
      onRemove={onRemove}
      removing={overrides.removing ?? false}
      removeError={overrides.removeError ?? null}
      onClose={onClose}
    />
  );
  return { ...utils, onToggle, onRemove, onClose };
}

describe("FriendOptionsPopup", () => {
  it("shows the given friendName as the dialog's accessible name and heading", () => {
    renderPopup({ friendName: "Bo" });

    expect(screen.getByRole("dialog", { name: "Options for Bo" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bo" })).toBeInTheDocument();
  });

  // Decision 2 (settled, not overridable): the design shows eight checkbox labels (built before
  // the daily-digest checkbox was removed from FriendSettingsFields) - this popup renders the
  // real, current, seven-field component instead, so there is no eighth checkbox to drop by hand.
  it("renders exactly seven checkboxes reflecting the given settings, with no eighth daily-digest checkbox", () => {
    renderPopup();

    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
    expect(screen.getByLabelText("I may send this friend a live nudge")).toBeChecked();
    expect(screen.getByLabelText("This friend may send me a live nudge")).toBeChecked();
    expect(
      screen.queryByLabelText("Receive a daily digest about this friend")
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Share my distraction attempts with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my current site with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my session goal text with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my intervention count with this friend")).not.toBeChecked();
    expect(screen.getByLabelText("Share my full session history with this friend")).not.toBeChecked();
  });

  it("calls onToggle with the friendId, field, and new checked value when a checkbox is flipped", () => {
    const { onToggle } = renderPopup();

    fireEvent.click(screen.getByLabelText("Share my current site with this friend"));

    expect(onToggle).toHaveBeenCalledWith("user-friend", "shareCurrentDomain", true);
  });

  it("shows the no-settings-row message and zero checkboxes when settings is undefined", () => {
    renderPopup({ settings: undefined });

    expect(screen.getByText(/no settings row yet for this friend/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    // The Remove Friend action is still available even with no settings row.
    expect(screen.getByRole("button", { name: "Remove friend" })).toBeInTheDocument();
  });

  it("shows the settingsError inline", () => {
    renderPopup({ settingsError: "network down" });

    expect(screen.getByRole("alert")).toHaveTextContent("network down");
  });

  it("shows the saveError inline", () => {
    renderPopup({ saveError: "could not save" });

    expect(screen.getByRole("alert")).toHaveTextContent("could not save");
  });

  it("calls onRemove with the friendId when Remove friend is clicked", () => {
    const { onRemove } = renderPopup();

    fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));

    expect(onRemove).toHaveBeenCalledWith("user-friend");
  });

  it("disables Remove friend and relabels it 'Removing…' while removing is true", () => {
    renderPopup({ removing: true });

    expect(screen.getByRole("button", { name: "Removing…" })).toBeDisabled();
  });

  it("shows the removeError inline", () => {
    renderPopup({ removeError: "could not remove" });

    expect(screen.getByRole("alert")).toHaveTextContent("could not remove");
  });

  it("calls onClose when the close button is clicked", () => {
    const { onClose } = renderPopup();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the backdrop is clicked, but not when the dialog card itself is clicked", () => {
    const { onClose } = renderPopup();

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
