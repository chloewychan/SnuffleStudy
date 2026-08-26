import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabase } from "./supabaseClient";
import {
  listMyFriendshipSettings,
  getFriendshipSettings,
  updateFriendshipSettings,
} from "./friendshipSettingsApi";

// Spies on the supabaseClient module's exported singleton, same boundary/style as
// friendGroupApi.test.ts/nudgeApi.test.ts - nothing here ever lets the real client make a
// network call.
beforeEach(() => {
  vi.restoreAllMocks();
});

// Minimal fake of supabase-js's PostgrestFilterBuilder - mirrors nudgeApi.test.ts's makeBuilder,
// plus `.maybeSingle()`/`.single()` for this file's single-row lookups.
function makeBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: {
    select: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    then: (resolve: (value: typeof result) => unknown, reject: (err: unknown) => unknown) => unknown;
  } = {
    select: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    single: vi.fn().mockResolvedValue(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  builder.select.mockReturnValue(builder);
  builder.update.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  return builder;
}

function mockSignedIn(userId: string) {
  return vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  } as never);
}

function mockSignedOut() {
  return vi.spyOn(supabase.auth, "getUser").mockResolvedValue({
    data: { user: null },
    error: null,
  } as never);
}

const sampleRow = {
  user_id: "user-a",
  friend_user_id: "user-b",
  receive_live_nudges: true,
  send_live_nudges: true,
  receive_daily_digest: true,
  nudge_cooldown_seconds_written: 300,
  nudge_cooldown_seconds_audio: 300,
  share_distraction_attempts: false,
  share_current_domain: false,
  share_goal_text: false,
  share_intervention_count: false,
  share_full_history: false,
};

const sampleSettings = {
  userId: "user-a",
  friendUserId: "user-b",
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

describe("friendshipSettingsApi.listMyFriendshipSettings", () => {
  it("selects every friendship_settings row owned by the current user, mapped to camelCase", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: [sampleRow], error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await listMyFriendshipSettings();

    expect(fromSpy).toHaveBeenCalledWith("friendship_settings");
    expect(builder.eq).toHaveBeenCalledWith("user_id", "user-a");
    expect(result).toEqual([sampleSettings]);
  });

  it("throws when not signed in", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(listMyFriendshipSettings()).rejects.toThrow(/not signed in/i);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("throws with the underlying error message on a query failure", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "boom" } }) as never
    );

    await expect(listMyFriendshipSettings()).rejects.toThrow("boom");
  });
});

describe("friendshipSettingsApi.getFriendshipSettings", () => {
  it("selects the row for one specific friend using maybeSingle (null, not an error, when absent)", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: null, error: null });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await getFriendshipSettings("user-b");

    expect(fromSpy).toHaveBeenCalledWith("friendship_settings");
    expect(builder.eq).toHaveBeenCalledWith("user_id", "user-a");
    expect(builder.eq).toHaveBeenCalledWith("friend_user_id", "user-b");
    expect(builder.maybeSingle).toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("returns the mapped row when it exists", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: sampleRow, error: null }) as never
    );

    const result = await getFriendshipSettings("user-b");

    expect(result).toEqual(sampleSettings);
  });
});

describe("friendshipSettingsApi.updateFriendshipSettings", () => {
  it("updates only the given patch fields (camelCase -> snake_case), scoped to (user_id, friend_user_id)", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({
      data: { ...sampleRow, share_current_domain: true },
      error: null,
    });
    const fromSpy = vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    const result = await updateFriendshipSettings("user-b", { shareCurrentDomain: true });

    expect(fromSpy).toHaveBeenCalledWith("friendship_settings");
    expect(builder.update).toHaveBeenCalledWith({ share_current_domain: true });
    expect(builder.eq).toHaveBeenCalledWith("user_id", "user-a");
    expect(builder.eq).toHaveBeenCalledWith("friend_user_id", "user-b");
    expect(builder.single).toHaveBeenCalled();
    expect(result.shareCurrentDomain).toBe(true);
  });

  it("maps every patchable field to its snake_case column", async () => {
    mockSignedIn("user-a");
    const builder = makeBuilder({ data: sampleRow, error: null });
    vi.spyOn(supabase, "from").mockReturnValue(builder as never);

    await updateFriendshipSettings("user-b", {
      receiveLiveNudges: false,
      sendLiveNudges: false,
      receiveDailyDigest: false,
      nudgeCooldownSecondsWritten: 60,
      nudgeCooldownSecondsAudio: 45,
      shareDistractionAttempts: true,
      shareCurrentDomain: true,
      shareGoalText: true,
      shareInterventionCount: true,
      shareFullHistory: true,
    });

    expect(builder.update).toHaveBeenCalledWith({
      receive_live_nudges: false,
      send_live_nudges: false,
      receive_daily_digest: false,
      nudge_cooldown_seconds_written: 60,
      nudge_cooldown_seconds_audio: 45,
      share_distraction_attempts: true,
      share_current_domain: true,
      share_goal_text: true,
      share_intervention_count: true,
      share_full_history: true,
    });
  });

  it("throws a helpful error when the row doesn't exist yet (zero rows matched)", async () => {
    mockSignedIn("user-a");
    vi.spyOn(supabase, "from").mockReturnValue(
      makeBuilder({ data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } }) as never
    );

    await expect(updateFriendshipSettings("user-b", { shareCurrentDomain: true })).rejects.toThrow();
  });

  it("throws when not signed in, without touching the database", async () => {
    mockSignedOut();
    const fromSpy = vi.spyOn(supabase, "from");

    await expect(updateFriendshipSettings("user-b", { shareCurrentDomain: true })).rejects.toThrow(
      /not signed in/i
    );
    expect(fromSpy).not.toHaveBeenCalled();
  });
});
