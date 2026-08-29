import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StudyRoomAccessPopup } from "./StudyRoomAccessPopup";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { ExtensionMessage } from "../../shared/messages";

// v4.2 Task 5: StudyRoomAccessPopup replaces StudyRoomsBox.tsx's old inline ManageAccessSection.
// Decision 3 (settled): this is a real, narrower behavior than the old component - it only ever
// lists currently-invited friends with a remove-only action; there is no add-toggle anywhere in
// this component (granting access is the Friends box's job, STUDY_ROOM_INVITEE_ADD, already
// built in v4.1 Task 9). This file covers the popup's own list/remove/archive/dismiss behavior in
// isolation; StudyRoomsBox.test.tsx covers how the popup gets opened and wired to a specific room.

const sampleInvitees = [
  { roomId: "room-1", userId: "friend-1", invitedBy: "user-self", invitedAt: "2026-01-01T00:00:00.000Z" },
  { roomId: "room-1", userId: "friend-2", invitedBy: "user-self", invitedAt: "2026-01-02T00:00:00.000Z" },
];

type Handler = (msg: ExtensionMessage) => unknown;

function routeSendMessage(overrides: Partial<Record<ExtensionMessage["type"], Handler>>) {
  const defaults: Partial<Record<ExtensionMessage["type"], Handler>> = {
    STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: sampleInvitees }),
    PROFILES_FETCH_BY_IDS: () => ({ ok: true, profiles: [] }),
  };
  return (msg: ExtensionMessage) => {
    const handler = overrides[msg.type] ?? defaults[msg.type];
    return Promise.resolve(handler ? handler(msg) : { ok: true });
  };
}

function renderPopup(
  overrides: Partial<{
    roomId: string;
    roomName: string;
    archiving: boolean;
    archiveError: string | null;
    onArchive: () => void;
    onClose: () => void;
  }> = {}
) {
  const onArchive = overrides.onArchive ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const utils = render(
    <StudyRoomAccessPopup
      roomId={overrides.roomId ?? "room-1"}
      roomName={overrides.roomName ?? "Thursday study group"}
      archiving={overrides.archiving ?? false}
      archiveError={overrides.archiveError ?? null}
      onArchive={onArchive}
      onClose={onClose}
    />
  );
  return { ...utils, onArchive, onClose };
}

describe("StudyRoomAccessPopup", () => {
  it("loads and lists currently-invited friends via STUDY_ROOM_INVITEES_LIST, resolving display names", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        PROFILES_FETCH_BY_IDS: () => ({
          ok: true,
          profiles: [
            { userId: "friend-1", humanName: "Alex" },
            { userId: "friend-2", humanName: "Bo" },
          ],
        }),
      })
    );

    renderPopup();

    expect(await screen.findByText("Alex")).toBeInTheDocument();
    expect(screen.getByText("Bo")).toBeInTheDocument();
  });

  it("falls back to the raw userId when no display name is available", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    renderPopup();

    expect(await screen.findByText("friend-1")).toBeInTheDocument();
  });

  it("passes the given roomId to STUDY_ROOM_INVITEES_LIST and shows the given roomName as the title", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(routeSendMessage({}));

    renderPopup({ roomId: "room-42", roomName: "Friday cram session" });

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "STUDY_ROOM_INVITEES_LIST",
        payload: { roomId: "room-42" },
      })
    );
    expect(screen.getByRole("heading", { name: "Friday cram session" })).toBeInTheDocument();
  });

  it("shows the load error inline when STUDY_ROOM_INVITEES_LIST fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_INVITEES_LIST: () => ({ ok: false, error: "network down" }) })
    );

    renderPopup();

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });

  it("shows an empty message when no one is currently invited", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_INVITEES_LIST: () => ({ ok: true, invitees: [] }) })
    );

    renderPopup();

    expect(await screen.findByText("No one is currently invited to this room.")).toBeInTheDocument();
  });

  // Decision 3 (settled): no add-toggle, no path to invite someone new from this popup at all.
  it("has no add-toggle or invite affordance anywhere in this popup", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(routeSendMessage({}));

    renderPopup();
    await screen.findByText("friend-1");

    expect(screen.queryByText(/invite/i)).not.toBeInTheDocument();
    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "STUDY_ROOM_INVITEE_ADD" })
    );
  });

  it("removes an invitee via STUDY_ROOM_INVITEE_REMOVE and drops them from the list", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({ STUDY_ROOM_INVITEE_REMOVE: () => ({ ok: true }) })
    );

    renderPopup();
    await screen.findByText("friend-1");

    fireEvent.click(screen.getAllByRole("button", { name: /remove friend from room/i })[0]!);

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "STUDY_ROOM_INVITEE_REMOVE",
        payload: { roomId: "room-1", userId: "friend-1" },
      })
    );
    await waitFor(() => expect(screen.queryByText("friend-1")).not.toBeInTheDocument());
    expect(screen.getByText("friend-2")).toBeInTheDocument();
  });

  it("shows the error inline and keeps the invitee in the list when STUDY_ROOM_INVITEE_REMOVE fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(
      routeSendMessage({
        STUDY_ROOM_INVITEE_REMOVE: () => ({ ok: false, error: "not the room owner" }),
      })
    );

    renderPopup();
    await screen.findByText("friend-1");

    fireEvent.click(screen.getAllByRole("button", { name: /remove friend from room/i })[0]!);

    expect(await screen.findByRole("alert")).toHaveTextContent("not the room owner");
    expect(screen.getByText("friend-1")).toBeInTheDocument();
  });

  it("disables Archive Study Room and shows 'Archiving…' while archiving is true", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    renderPopup({ archiving: true });
    await screen.findByText("friend-1");

    expect(screen.getByRole("button", { name: "Archiving…" })).toBeDisabled();
  });

  it("calls the passed-in onArchive when Archive Study Room is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    const { onArchive } = renderPopup();
    await screen.findByText("friend-1");

    fireEvent.click(screen.getByRole("button", { name: "Archive Study Room" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("shows the archive error inline when one is passed in", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    renderPopup({ archiveError: "could not archive" });
    await screen.findByText("friend-1");

    expect(screen.getByRole("alert")).toHaveTextContent("could not archive");
  });

  it("calls onClose when the close button is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    const { onClose } = renderPopup();
    await screen.findByText("friend-1");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the backdrop is clicked, but not when the dialog card itself is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(routeSendMessage({}));

    const { onClose } = renderPopup();
    await screen.findByText("friend-1");

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-fetches invitees for the new room when roomId changes", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockImplementation(routeSendMessage({}));

    const { rerender } = renderPopup();
    await screen.findByText("friend-1");

    sendMessageSpy.mockClear();
    rerender(
      <StudyRoomAccessPopup
        roomId="room-2"
        roomName="Other room"
        archiving={false}
        archiveError={null}
        onArchive={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "STUDY_ROOM_INVITEES_LIST",
        payload: { roomId: "room-2" },
      })
    );
  });
});
