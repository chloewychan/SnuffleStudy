import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDisplayNames } from "./useDisplayNames";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { Profile } from "../../infrastructure/backend/profileApi";

beforeEach(() => {
  vi.restoreAllMocks();
});

const sampleProfile: Profile = {
  userId: "user-a",
  humanName: "Alice",
  bunnyName: "Fluffball",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("useDisplayNames", () => {
  it("resolves ids to their human_name once PROFILES_FETCH_BY_IDS returns", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, profiles: [sampleProfile] });

    const { result } = renderHook(() => useDisplayNames(["user-a"]));

    // Before the fetch resolves, every id still falls back to its own raw value.
    expect(result.current("user-a")).toBe("user-a");

    await waitFor(() => expect(result.current("user-a")).toBe("Alice"));

    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "PROFILES_FETCH_BY_IDS",
      payload: { userIds: ["user-a"] },
    });
  });

  it("falls back to the raw id for any id with no matching profile or no human_name", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      profiles: [{ ...sampleProfile, humanName: null }],
    });

    const { result } = renderHook(() => useDisplayNames(["user-a", "user-stranger"]));

    await waitFor(() => expect(messenger.sendMessage).toHaveBeenCalled());
    // Neither id resolves: user-a's profile has no human_name, and user-stranger's was never
    // returned at all (e.g. RLS silently omitted it) - both fall back identically.
    expect(result.current("user-a")).toBe("user-a");
    expect(result.current("user-stranger")).toBe("user-stranger");
  });

  it("falls back to every raw id when the fetch fails (never throws)", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: false, error: "boom" });

    const { result } = renderHook(() => useDisplayNames(["user-a"]));

    await waitFor(() => expect(messenger.sendMessage).toHaveBeenCalled());
    expect(result.current("user-a")).toBe("user-a");
  });

  it("falls back to every raw id when sendMessage itself rejects (never throws)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(new Error("connection lost"));

    const { result } = renderHook(() => useDisplayNames(["user-a"]));

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    expect(result.current("user-a")).toBe("user-a");
  });

  it("does not call sendMessage at all for an empty id list", () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage");

    const { result } = renderHook(() => useDisplayNames([]));

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(result.current("anyone")).toBe("anyone");
  });

  it("does not re-fetch when re-rendered with a new array instance containing the same ids", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, profiles: [sampleProfile] });

    const { result, rerender } = renderHook(({ ids }) => useDisplayNames(ids), {
      initialProps: { ids: ["user-a"] },
    });
    await waitFor(() => expect(result.current("user-a")).toBe("Alice"));
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    // A brand-new array instance with the same one id - callers recompute this from other state
    // on every render, so this must not trigger a second fetch.
    rerender({ ids: ["user-a"] });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });
});
