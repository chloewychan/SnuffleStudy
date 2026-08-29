# Task 7 report — Study Room split: persistent session state, Study-tab box, footer, `AppFooter` shell

## Pre-flight verification against the live repo

Read the plan's Goal/Architecture/Tech Stack/Global Constraints/Decisions 4/5/7/8/9, the full Task 7
block, and the scope doc's "New Footer"/"Study Tab"/"Other Pages — Study Session" sections before
starting. Read Task 1's and Task 2's reports plus the actual current files they touched:

- **Task 1** landed exactly as its report describes: `nudgeVaultApi.ts` (`createVaultText`/
  `listMyVaultTexts`/`deleteVaultText`), `producerTagApi.ts`'s `listMine()`/`softDelete()`,
  `nudgeApi.ts`'s `NudgeSource` union and `sendNudge(friendUserId, source)`, and
  `messageRouter.ts`'s new cases (`NUDGE_VAULT_TEXT_CREATE/LIST/DELETE`,
  `PRODUCER_TAG_LIST_MINE/DELETE`, `NUDGE_SEND`'s narrowed payload) were all confirmed present by
  reading the files directly, not assumed from the plan's snippets.
- **Task 2** landed `RefreshRegistryContext.tsx` and the `SidePanelApp`/`SidePanelAppInner` split
  described in its report — confirmed by reading `SidePanelApp.tsx` directly. My edits build on
  that split (adding `StudyRoomSessionProvider` as a second wrapper around `SidePanelAppInner`,
  order-independent from `RefreshRegistryProvider` per the plan) rather than against the plan's
  original single-component snapshot.
- Read `StudyRoomPanel.tsx` (943 lines) in full before splitting it — the actual joined-room state,
  handlers, and JSX matched the plan's description closely; no material staleness found.
- Read `StudyTab.tsx`, `FriendsTab.tsx`, `ActiveSessionView.tsx` in their current (post-Task-6)
  form before editing — `StudyTab.tsx` already had `SessionSetupForm`/`TaskVaultPage` as two
  `sp-card`s with a shared, sorted `tasks` mirror (Task 6); my edit is additive (a third card), not
  a rewrite.

## What was built

- **`sidepanel/studyRoom/StudyRoomSessionContext.tsx`** (new) — `StudyRoomSessionProvider`/
  `useStudyRoomSession()`. Moved verbatim from `StudyRoomPanel.tsx`: `Tile`, `applyPresenceEvent`,
  `joinedRoom`/`participants`/`tiles`/`cameraOn`/`micOn`/`mediaError` state, the two
  `videoCallClient`-driven `useEffect`s (track wiring + unmount cleanup), `handleToggleCamera`/
  `handleToggleMic`. New: `selectedParticipantIds: Set<string>` + `toggleParticipantSelected`/
  `clearParticipantSelection`, cleared at the start of every `joinRoom()` call and in `leaveRoom()`'s
  `finally`, same lifecycle as `tiles`/`participants`.
  - **Dropped, not moved** (Decision 9 + scope doc "remove the ability to record a producer tag
    from inside the room"): `roomTags`, `unsubscribeRoomTagsRef`,
    `producerTagApi.subscribeToRoomProducerTags`, `handleIncomingRoomTag`,
    `handleSendProducerTagToRoom`. The room-broadcast backend itself is untouched, per Decision 9.
  - **One real behavior change from relocation**: the old `handleJoinRoom` read `selfUserId` from
    component state (populated once via a `loadSelf()` the whole `StudyRoomPanel` also used for its
    signed-out gate). The provider has no reason to track "am I signed in" — that stays
    `StudyRoomsBox`'s own concern — so `joinRoom()` now resolves the current user's id with its own
    fresh `AUTH_GET_SESSION` call, used only to seed the initial "You" placeholder tile before
    `joinCall` runs. This adds one extra round-trip per join compared to before (previously
    piggybacked on a fetch that had already run). Judgment call: correct and simpler than threading
    `selfUserId` through the context's public interface (which the plan's own `StudyRoomSessionValue`
    shape doesn't include) for a value only the join path needs.
- **`sidepanel/components/AppFooter.tsx`** (new) — exactly the plan's snippet: renders
  `<StudyRoomFooter />` when `joinedRoom` is truthy, else `null`, with the two comments marking
  where Task 8 extends it.
- **`sidepanel/components/StudyRoomsBox.tsx`** (new) — `StudyRoomPanel`'s entire "not joined"
  branch, including `ManageAccessSection`, moved with the two changes the plan specifies:
  - Room list `<li>`s are now `onClick`-select (`selectedRoomId` state) + `aria-selected`, no
    per-item Join button. One "Join study room" button below the list calls
    `useStudyRoomSession().joinRoom(room, { camera, microphone })` for the selected room, disabled
    while nothing's selected or `joining !== null`.
  - "Archive this room" moved inside `ManageAccessSection`'s own render (still gated on
    `manageAccessRoomId === room.id`); `ManageAccessSection` now takes `archiving`/`archiveError`/
    `onArchive` props from the parent (archive state itself stays in the parent — only one room's
    section is ever expanded at a time, so a single shared `archiveError` is unambiguous exactly as
    it was before this task).
  - `useRegisterRefresh(loadRooms)` replaces the old inline Refresh button.
  - Kept an **optional** `onClose` prop (unused by the only current caller, `StudyTab.tsx`),
    mirroring the existing `StudyRoomPanel`/`FriendGroupPanel` "no dead button" precedent from v3.4
    Task 4, since the plan describes this branch as "unchanged in behavior" apart from the two
    named changes. Judgment call, flagged here rather than silently dropping a capability the plan
    didn't ask to remove.
- **`sidepanel/components/StudyRoomFooter.tsx`** (new) — the joined-room branch, reading
  everything from `useStudyRoomSession()`:
  1. The `study-room-panel__presence` section (both the `<h3>In this room (N)</h3>` heading and the
     `<ul>` of names) is removed entirely, not just the `<ul>` — the heading only ever described
     that list, and removing just the `<ul>` would leave a headline with nothing under it. Judgment
     call, noted since the plan's literal wording only names the `<ul>`.
  2. Each `StudyRoomVideoTile` (also moved here — it's a rendering concern, only ever mounted while
     joined) gets `onClick`/`role="button"`/`tabIndex=0`/`aria-pressed` + a keyboard handler
     (Enter/Space) toggling `selectedParticipantIds`, beyond the plan's literal `onClick`-only
     snippet — cheap, correct, and consistent with the `aria-pressed` semantic the plan itself asks
     for.
  3. The entire `study-room-panel__producer-tags` section is gone. Replaced with one Nudge button +
     a `<select>` built by merging `NUDGE_VAULT_TEXT_LIST` + `PRODUCER_TAG_LIST_MINE` (both via
     `sendMessage`, **not** a direct `nudgeVaultApi`/`producerTagApi` import — both files'
     own header comments document "never imported directly by a sidepanel component," so this
     follows that existing convention exactly), sorted by `createdAt` descending, inlined per the
     plan's own note that Task 9's `useNudgeVaultItems()` hook will later replace this — not built
     here, since that's explicitly Task 9's deliverable.
  - Pressing Nudge fires one `NUDGE_SEND({friendUserId, vaultTextId})` (written) or
    `PRODUCER_TAG_SEND_TO_FRIEND({tagId, friendUserId})` (audio) per id in
    `selectedParticipantIds` (Decision 7/8), each wrapped in its own `.catch` so one recipient's
    rejection can't become an unhandled rejection or block the others in the loop, then always
    calls `clearParticipantSelection()` in a `finally` (matching the standing rule against bare
    async calls in UI handlers, and matching Decision 7's "no new bulk-send message" per-target
    loop).
  - `joinError` display was **not** carried into this file — in the original component it was
    (oddly) duplicated into both branches, but a non-null `joinError` by construction means the
    join failed, so `joinedRoom` is still null and that branch never actually renders in practice.
    Kept only in `StudyRoomsBox` (the branch where it's actually reachable). Minor cleanup, not a
    behavior change.
  - `useRegisterRefresh` wired to the vault-item fetch (this footer had no refresh button before,
    but its new vault picker needs to react to the Header's Refresh button).
- **`StudyRoomPanel.tsx` and `StudyRoomPanel.test.tsx` deleted.** Test coverage split (not
  discarded) into `StudyRoomsBox.test.tsx` (18 tests: list load/error, create, click-to-select +
  single Join button, join-error surfacing, refresh-registry registration, archive now inside
  Manage access, Manage access invite/remove, pre-join camera/mic toggle, signed-out gate) and
  `StudyRoomFooter.test.tsx` (15 tests: renders-nothing-when-not-joined, no participant list, no
  producer-tag UI, tile selection toggling, local-video mirroring, media-error guidance, mid-room
  camera toggle, leave-room teardown, vault-item load/merge/sort, written-nudge send,
  audio-nudge send, disabled-until-both-selected, partial-failure surfacing, and the
  QA-pass stale-tile-across-rejoin regression guard). Also added `AppFooter.test.tsx` (2 tests).
  The old file's in-room producer-tag-recording tests (`PRODUCER_TAG_UPLOAD`/
  `PRODUCER_TAG_SEND_TO_ROOM` from inside the room) were dropped, not ported — that feature is
  removed, not relocated, per Decision 9 and the scope doc.
- **`StudyTab.tsx`**: `<StudyRoomsBox />` mounted as a third `sp-card`, alongside
  `SessionSetupForm`/`TaskVaultPage`.
- **`FriendsTab.tsx`**: `<StudyRoomPanel />` mount removed (no replacement — now two `sp-card`s,
  `FriendGroupPanel` + `FriendRequestPanel`).
- **`SidePanelApp.tsx`**: `StudyRoomSessionProvider` added as a second wrapper around
  `SidePanelAppInner`, alongside Task 2's `RefreshRegistryProvider` (order-independent, per the
  plan). `<AppFooter />` added immediately after the tab content in the no-session branch, and in
  the COMPLETED/ABANDONED branches (which have no `<Header />`, so `AppFooter` was added as a plain
  sibling, per the plan's own instruction that it doesn't need `Header` as a sibling). **Beyond the
  plan's literal enumeration**, I also added `<AppFooter />` to the `showFriendRequestPanel` branch
  (a session-active variant `SidePanelApp.test.tsx` and Task 2's report both document as a real,
  distinct render branch the plan's Task 7 text doesn't individually name). Judgment call: Decision
  5 says footers render "everywhere except onboarding," and this branch is a session-active screen,
  not onboarding — and Task 8's own Deliverables describe this exact branch being **removed
  entirely** next task, folded into the always-visible footer, so leaving it without a footer for
  one task's lifetime seemed like the wrong default. Flagged here in case a reviewer would rather
  Task 7 stick to the plan's literal four branches and let Task 8 add it when the branch is
  restructured anyway.
- **`ActiveSessionView.tsx`** (Decision 4): removed `members`/`membersError`/`nudgingUserId`/
  `nudgeError`/`selfUserId` state, both `useEffect`s populating them, `nudge()`, `nudgeableMembers`,
  the `NUDGE_MESSAGES`/`DEFAULT_NUDGE_MESSAGE_ID` import and constant, the `AuthUser`/`AuthSession`
  local types, the now-unused `sendMessage` import, and the entire `sp-active-session__room` JSX
  block. The "Friend requests" escape-hatch button is untouched, per the plan.
- **`styles/sidepanel.css`**: added `.study-room-panel__tile--selected`/`.study-room-panel__room`/
  `.study-room-panel__room--selected` (a 2px outline using the existing `--color-primary` token,
  matching `.sp-tabbar__tab--active`'s existing outline-weight convention — not new visual design)
  and `.sp-app-footer` (reuses `.sp-card`'s existing border/radius/padding treatment). The plan's
  Deliverables section for this task doesn't mention CSS, but an unstyled selection state and an
  unstyled footer container felt like an omission worth avoiding at near-zero cost, mirroring Task
  2's own judgment call on `.sp-header__refresh-button`.

## What was verified

- `npm run compile` (`tsc --noEmit`): clean, both immediately after implementation and after all
  test-file edits.
- `npx vitest run` (full suite): **887/887 passing across 86 files**, run three times in a row with
  no flakes (the task brief specifically flagged the old `StudyRoomPanel.test.tsx`'s pre-existing
  full-suite flake as something to watch for when splitting its coverage — that file no longer
  exists, and its likely cause, `ProducerTagRecorder`'s recording `setInterval`, is no longer
  exercised by any in-room test since in-room recording is removed). No unhandled-rejection or
  `act()` warnings appeared in any of the three runs.
- Targeted runs of every file this task touched (`StudyRoomsBox.test.tsx`,
  `StudyRoomFooter.test.tsx`, `AppFooter.test.tsx`, `StudyTab.test.tsx`, `FriendsTab.test.tsx`,
  `ActiveSessionView.test.tsx`, `SidePanelApp.test.tsx`, `Header.test.tsx`) all green.
- `grep -rn "StudyRoomPanel"` across `src/`: only comment references remain (historical rationale
  comments in unrelated files, e.g. `shared/messages.ts`, `AccountPage.tsx`), no actual imports —
  confirmed the deletion didn't leave a dangling reference anywhere.
- `grep -rn "sp-active-session__room|nudgeableMembers|DEFAULT_NUDGE_MESSAGE_ID"`: zero matches —
  confirmed `ActiveSessionView.tsx` and its CSS are fully clean of the removed section.
- Manually traced `SidePanelApp.tsx`: `AppFooter` sits outside the `activeTab === ... &&`
  conditional block (a sibling after the `role="tabpanel"` div) and is duplicated into every
  session-state branch except onboarding/loading/settings-error — confirmed by reading the file
  top to bottom after editing, not just diffing.
- Manually traced `StudyRoomsBox.tsx`: no `<button>` inside the room `<li>` calls `joinRoom`
  directly; the only `joinRoom` call site is the one button below the list — confirmed by reading
  the file, and by the passing "has no per-item Join button" test which explicitly asserts
  `queryByRole("button", { name: /^join$/i })` is absent.
- Manually traced `ActiveSessionView.tsx`: re-read the full file after editing — no `members`,
  `nudge`, or `sp-active-session__room` remain; only goal/timer/progress/restricted-sites/
  escape-hatch remain, matching the DoD's explicit check.

## What's still open

- **Live two-account testing is explicitly Task 11's job**, not attempted here: joining a real
  LiveKit room, switching tabs while connected, starting a study session while joined, and
  confirming the call survives without a fresh reconnect all require a live browser session with
  real camera/mic and two real accounts — none of which this task's environment can exercise. Every
  test above is mock-verified only (same posture the pre-existing `StudyRoomPanel.test.tsx` already
  had for its own camera/mic-toggle coverage, per that file's own header comment).
- **`useNudgeVaultItems()`** (Task 9's shared hook) doesn't exist yet — `StudyRoomFooter.tsx`
  inlines its own merge-and-sort of `NUDGE_VAULT_TEXT_LIST`/`PRODUCER_TAG_LIST_MINE`, exactly as
  the plan directs ("Task 9's deliverables include that one-line refactor back into
  `StudyRoomFooter.tsx`" once the hook exists). Not built here.
- **`AppFooter`'s early-return condition** (`if (!joinedRoom) return null;`) will need widening by
  Task 8 to also account for undismissed nudges/pending requests — left exactly as the plan's own
  snippet specifies, with the marker comment in place.
- The `showFriendRequestPanel` branch's `<AppFooter />` addition (noted above as a judgment call
  beyond the plan's literal four branches) is short-lived — Task 8 removes that whole branch. Worth
  a quick sanity check from whoever picks up Task 8 that removing the branch also removes this
  extra `<AppFooter />` cleanly (it should, since the branch is deleted wholesale).

## Files touched

- New: `snufflestudy/src/sidepanel/studyRoom/StudyRoomSessionContext.tsx`,
  `snufflestudy/src/sidepanel/components/{AppFooter,StudyRoomsBox,StudyRoomFooter}.tsx` and their
  `.test.tsx` files.
- Deleted: `snufflestudy/src/sidepanel/components/StudyRoomPanel.tsx` and
  `StudyRoomPanel.test.tsx`.
- Edited: `snufflestudy/src/sidepanel/SidePanelApp.tsx`,
  `snufflestudy/src/sidepanel/components/{StudyTab,FriendsTab,ActiveSessionView}.tsx` and their
  `.test.tsx` files (`FriendsTab.test.tsx`, `StudyTab.test.tsx`, `ActiveSessionView.test.tsx`),
  `snufflestudy/src/sidepanel/SidePanelApp.test.tsx`, `snufflestudy/src/styles/sidepanel.css`.
