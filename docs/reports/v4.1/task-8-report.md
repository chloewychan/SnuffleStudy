# Task 8 report — Incoming activity + `NudgesAndRequestsFooter`

## Pre-flight verification against the live repo

Read the plan's Goal/Architecture/Tech Stack/Global Constraints/Decisions (especially Decision 3,
which this task exists to implement) and the full Task 8 block, plus the scope doc's "Nudges &
Unlock Requests footer" section, before starting. Read `docs/reports/v4.1/task-7-report.md` in
full, then read every file this task touches in its current, post-Task-7 form rather than trusting
the plan's snapshot:

- **`sidepanel/components/AppFooter.tsx`** matched the report exactly: `if (!joinedRoom) return
  null;` with two marker comments for this task to fill in.
- **`infrastructure/storage/nudgeDismissalState.ts`** was still in its Task-1-landed old watermark
  form (`getLastDismissedNudgeSentAt`/`setLastDismissedNudgeSentAt`), confirmed by reading it
  directly — Task 1 did not touch its shape, exactly as the brief said.
- **`sidepanel/components/friendGroupPanel/useFriendGroupPanelData.ts`** was the one caller of
  those two watermark functions outside `nudgeDismissalState.ts` itself (confirmed via
  `grep -rln`). `sidepanel/components/FriendGroupPanel.tsx` (its consumer) still renders
  `IncomingNudgeCard`/an incoming-producer-tag list directly — this task does **not** touch
  `FriendGroupPanel.tsx` (explicitly out of scope, Task 9's job), so that duplication between the
  old Friends-tab display and the new footer is real but expected for one task's lifetime, matching
  Task 9's own "Depends on Task 8" note about removing it later.
- **`sidepanel/components/FriendRequestPanel.tsx`** matched the plan's description of its
  logic (`loadSelf`/`loadRequests`/`handleResolve`/`detailLine`) exactly — no dedicated test file
  existed for it (`FriendRequestPanel.test.tsx` was never created; its behavior was only ever
  exercised indirectly through `FriendsTab.test.tsx`/`SidePanelApp.test.tsx`).
- **`SidePanelApp.tsx`** matched the report: `showFriendRequestPanel` state, its session-reset
  effect, and its dedicated render branch (composing `RequestUnlockForm` + `FriendRequestPanel`
  side by side) were all present and read in full before editing.
- **`ActiveSessionView.tsx`** matched the report: Decision 4's dead Study Room section was already
  gone (Task 7); only the "Friend requests" escape-hatch button and its
  `onShowFriendRequestPanel` prop remained, exactly as Task 7 left them.

## What was built

- **`infrastructure/storage/nudgeDismissalState.ts`** redesigned per Decision 3: the single
  `dismissedThroughSentAt` watermark is replaced by a persisted set of dismissed item keys.
  `getDismissedNudgeIds(): Promise<Set<string>>` and `markNudgeDismissed(key: DismissedItemKey):
  Promise<void>` (`chrome.storage.local`, JSON array ↔ Set), where `DismissedItemKey = { kind:
  "nudge" | "tag"; id: string }`. **Deviation from the plan's literal snippet**: the plan's own
  Decision 3 text shows `markNudgeDismissed(nudgeId: string)`, but the task's own "Note carried
  forward" callout says to extend the id-set to a `{kind, id}` key once audio tags share the same
  mechanism — I implemented that composite-key shape directly in this redesign (rather than
  landing the bare-string version first and widening it again for the tag stream), since building
  it twice within the same task added nothing. Also exported `encodeDismissedItemKey()` so every
  caller checking set membership encodes the same way this module persists, rather than duplicating
  the `${kind}:${id}` format ad hoc at each call site.
- **`sidepanel/components/friendGroupPanel/useFriendGroupPanelData.ts`** updated (not rewritten) to
  compile against the new storage shape: `dismissedThroughSentAt: number | null` became
  `dismissedNudgeIds: Set<string> | null`, and `dismissNudge`/`visibleNudge` now check set
  membership instead of comparing a timestamp cursor. This is a **required, in-scope fix** (the old
  exports this file imported no longer exist after the redesign), not a Task-9 rebuild — I did not
  touch `FriendGroupPanel.tsx`, `NudgeSendSection.tsx`, `IncomingNudgeCard.tsx`,
  `DigestSection.tsx`, or `FriendEventFeed.tsx`. Behavior is unchanged and verified unchanged by the
  full, still-passing `FriendGroupPanel.test.tsx` suite (including its two dismiss-specific
  regression tests), since this hook only ever surfaces the single oldest not-yet-dismissed nudge,
  in strictly increasing `sent_at` order — the same invariant that made the old watermark
  behaviorally correct for that one file still holds for a set-membership check.
- **`sidepanel/appFooter/useIncomingActivity.ts`** (new) — three independent streams, each moved
  with no behavior change to its underlying fetch/resolve call:
  - **nudges** (`NUDGES_FETCH`, 24h lookback, same as before) and **incomingTags**
    (`PRODUCER_TAG_SENDS_FETCH`, same lookback) — both filtered against the shared dismissed-id set,
    returning every undismissed item, oldest first (both backend queries already order ascending by
    `sent_at`, so filtering preserves that order with no extra sort needed).
  - **requests** (`FRIEND_REQUESTS_FETCH` + `AUTH_GET_SESSION` for self-identity) — moved verbatim
    from `FriendRequestPanel.tsx`'s `loadSelf`/`loadRequests`/`handleResolve`, same
    `FRIEND_REQUEST_RESOLVE`/`FRIEND_REQUEST_APPROVE_TEMP_PASS` split, same first-responder-wins
    error handling, same "pending, from others" filter.
  - **Deviations from the plan's literal interface**, both required by the task's own "Note carried
    forward" callout (folding in `PRODUCER_TAG_SENDS_FETCH` as a third stream): added
    `incomingTags`, `tagsError`, and `dismissTag(tag: IncomingProducerTag): void` to the
    `IncomingActivity` interface, alongside the plan's literal `nudges`/`nudgesError`/`requests`/
    `requestsError`/`resolvingRequestId`/`resolveError`/`dismissNudge`/`resolveRequest`/`refresh`.
    `dismissTag` takes the whole tag object rather than a bare id string, because
    `IncomingProducerTag` (a joined `producer_tag_sends`/`producer_tags` view) has no send-specific
    id field of its own — the same tag could in principle be sent more than once, so the dismissal
    id is a composite `${tagId}-${sentAt}`, mirroring the exact key `IncomingProducerTagCard.tsx`
    already uses for its own React list `key`.
  - **Polling**: added a 60s interval re-running `requests`/`nudges`/`tags` together, mirroring
    `useFriendGroupPanelData.ts`'s own v3.3-QA-pass fix. This is new for the request stream
    specifically — `FriendRequestPanel.tsx` never polled; it only refetched on mount (which used to
    happen "for free" every time a user left and returned to the Friends tab) or via its own local
    Refresh button. Since this hook now lives at the app-shell level and never unmounts, it needs
    the same interval-based re-fetch nudges/tags already had, or a pending request would only ever
    update via the Header's Refresh button.
- **`sidepanel/components/NudgesAndRequestsFooter.tsx`** (new) — receives `IncomingActivity` as
  props (see "single instantiation" note below) rather than calling the hook itself. Renders one
  merged, chronologically-sorted list for nudges + incoming audio tags under a "Nudges" heading
  (written nudges show `nudge.customBody ?? nudgeMessageText(nudge.messageId ?? "") ?? "sent you a
  nudge."` + a Dismiss button; audio nudges show a lazy-loaded `<audio>` player, moved verbatim from
  `NudgeSendSection.tsx`'s `IncomingProducerTagCard`, + a Dismiss button), and one list for pending
  requests under a "Friend requests" heading (`detailLine(request, requesterName)` moved verbatim
  from `FriendRequestPanel.tsx`, the optional message, an X/check button pair with `aria-label`
  "Deny"/"Approve"). Each section only renders once it has content **or its own fetch errored** —
  so an error is never silently dropped once the footer is already visible for some other reason,
  but a bare fetch failure with genuinely nothing pending doesn't force the whole footer into view
  by itself (that stays `AppFooter.tsx`'s own `hasIncomingActivity` gate). Calls
  `useRegisterRefresh(refresh)`.
- **`AppFooter.tsx`**: now calls `useIncomingActivity()` once and threads its result down as props
  to `NudgesAndRequestsFooter`. Widened early-return to
  `if (!joinedRoom && !hasIncomingActivity) return null;` where `hasIncomingActivity =
  nudges.length > 0 || requests.length > 0 || incomingTags.length > 0`, matching the plan's literal
  condition. **Design call**: the plan's own comment inside the `useIncomingActivity()` snippet says
  "this hook itself is only ever instantiated once, inside AppFooter" — since `AppFooter.tsx`'s own
  early-return condition needs the same `nudges`/`requests`/`incomingTags` arrays, the hook has to
  be called there (not inside `NudgesAndRequestsFooter`, which would mean two independent instances
  — two independent 60s poll loops — or `AppFooter` having no way to know whether to widen its
  return at all). One documented, minor consequence: `useRegisterRefresh` lives inside
  `NudgesAndRequestsFooter`, which only mounts once something is already showing — so if nothing is
  currently pending, clicking the Header's Refresh button won't force an *instant* re-fetch of
  nudges/requests (the ambient 60s poll, which runs regardless of `NudgesAndRequestsFooter`'s mount
  state since `useIncomingActivity()` itself always runs inside `AppFooter`, will still pick up new
  activity within that window). This matches the plan's own literal Deliverables text
  ("`useRegisterRefresh(refresh)` ... called from `NudgesAndRequestsFooter.tsx`") — flagged here in
  case a reviewer would rather move the registration up into `AppFooter.tsx` to close that edge case
  entirely.
- **`FriendRequestPanel.tsx` deleted.** `FriendsTab.tsx`'s mount of it removed (now composes only
  `<FriendGroupPanel />`, one `sp-card` instead of two).
- **`SidePanelApp.tsx`**: `showFriendRequestPanel` state, its session-reset effect, and its
  dedicated render branch removed entirely. `RequestUnlockForm` now renders directly alongside
  `ActiveSessionView` in the (now single) active-session return, unconditionally.
- **`ActiveSessionView.tsx`**: `onShowFriendRequestPanel` prop and the "Friend requests"
  escape-hatch button/`sp-active-session__escape-hatches` div removed. Removed the now-dead
  `.sp-active-session__escape-hatches` CSS rule too (left `.sp-active-session__friend-list`
  alone — that was already dead before this task, from Task 7's Decision-4 removal, and isn't
  something this task's own changes made dead).

## What was verified

- `npm run compile` (`tsc --noEmit`): clean.
- `npx vitest run`: **902/902 passing across 87 files**, run twice in a row with no flakes (up from
  Task 7's 887/887 — net +15 tests: a new `NudgesAndRequestsFooter.test.tsx` covering rendering,
  ordering, dismiss/resolve wiring, error surfacing, and refresh registration against crafted props;
  and a new describe block in `AppFooter.test.tsx` covering the real, end-to-end
  `useIncomingActivity()` behavior — including the specific Decision-3 regression case).
- `grep -rn "showFriendRequestPanel\|FriendRequestPanel" snufflestudy/src`: **zero matches** —
  confirmed literally, including scrubbing every historical-comment reference across
  `messageRouter.ts`, `shared/messages.ts`, `friendRequestApi.ts`, `RequestUnlockForm.tsx`, and
  every file this task itself added/edited, not just live imports.
- `grep -rn "getLastDismissedNudgeSentAt|setLastDismissedNudgeSentAt"`: only one historical-comment
  reference remains, inside `nudgeDismissalState.ts`'s own header comment describing what it
  replaced — no code references the removed functions.
- **Manual trace of the Decision-3 case** (dismissing one nudge leaves an older, still-undismissed
  nudge visible): confirmed by reading `useIncomingActivity.ts`'s `dismissNudge`/`nudges` derivation
  — `dismissNudge(id)` adds exactly one key to the dismissed set; the `nudges` filter excludes only
  items whose own key is in that set, so any other nudge's presence in the array is untouched by
  another nudge's dismissal. Also confirmed by a real (not crafted-props) test in
  `AppFooter.test.tsx`: `"dismissing the newer of two nudges leaves the older, still-undismissed one
  visible (Decision 3)"`, exercising the actual hook + `chrome.storage.local` persistence via
  `fakeBrowser`, not a mock. A second test in the same file confirms the dismissal survives an
  unmount/remount (persisted, not just component state), mirroring
  `FriendGroupPanel.test.tsx`'s identical v3.4-QA-pass regression guard for the old panel.
- Manually traced `SidePanelApp.tsx` end to end after editing: exactly one active-session return
  branch remains (no toggle), `RequestUnlockForm` and `ActiveSessionView` both render
  unconditionally together, `AppFooter` is still rendered in every branch it was in before (no
  regression from Task 7's own placement).
- Manually traced `AppFooter.tsx`: confirmed `useIncomingActivity()` is called exactly once (inside
  `AppFooter`, not duplicated into `NudgesAndRequestsFooter`), and the early-return condition
  correctly covers both halves (`joinedRoom` and `hasIncomingActivity`) before either child renders.

## Judgment calls / deviations (summary)

1. `nudgeDismissalState.ts`'s `markNudgeDismissed` takes a `{kind, id}` key from the start (per the
   task's own "Note carried forward" callout), not the bare-`nudgeId` shape shown in Decision 3's
   own snippet — building the bare-string version first and widening it again in the same task
   would have been pure churn.
2. `IncomingActivity` gained `incomingTags`/`tagsError`/`dismissTag` beyond the plan's literal
   interface snippet — required by the same "Note carried forward" callout, which explicitly says
   this task folds in the audio-nudge stream as a third piece with its own dismiss story.
3. `dismissTag` takes the whole `IncomingProducerTag`, not a bare id, since that type has no
   send-specific id of its own (composite `${tagId}-${sentAt}`, matching the existing card
   component's own React key).
4. `useIncomingActivity()` is called inside `AppFooter.tsx` (not `NudgesAndRequestsFooter.tsx`),
   required by `AppFooter`'s own early-return condition needing the same data — with the
   consequence that `useRegisterRefresh` (placed in `NudgesAndRequestsFooter.tsx` per the plan's
   literal Deliverables text) is only live once something's already showing. Documented above as a
   minor, accepted gap rather than silently resolved either way.
5. Updated `useFriendGroupPanelData.ts` to compile against the redesigned storage module (a
   required consequence of the redesign, not a Task-9 rebuild) — `FriendGroupPanel.tsx` itself and
   its other children are untouched, so the old Friends-tab nudge/tag display and the new footer
   both independently show the same underlying data for one task's lifetime, exactly as the plan's
   own task-dependency notes anticipate (Task 9 "Depends on Task 8" specifically to remove that
   overlap).
6. `SidePanelApp.test.tsx`'s `beforeEach` chrome stub was extended with a minimal
   `storage.local.get`/`set` mock — without it, `useIncomingActivity`'s dismissed-id-set read would
   synchronously throw (caught, logged, degraded to an empty set) on every single test in that file,
   since that stub replaces `chrome.storage` wholesale with an `onChanged`-only object for
   `useActiveSession`'s listener. Low-risk, in-scope fix to a file this task already edits.

## What's still open

- **Live multi-item footer testing is Task 11's job**, not attempted here: everything above is
  verified via `fakeBrowser`/mocked `sendMessage`, not a live Supabase round trip with two real
  accounts. The scope doc's own QA script item ("generate two undismissed nudges and one pending
  request at once... dismiss the older nudge while the newer one and the request remain visible")
  is the same case this task's own tests exercise structurally, but a real end-to-end pass is
  explicitly deferred to Task 11.
- **`FriendGroupPanel.tsx`'s own incoming-nudge/tag display still exists**, duplicating the new
  footer for one task's lifetime — expected and tracked by Task 9's own "Depends on Task 8" note,
  not a gap introduced here.
- The minor Refresh-button gap noted in judgment call 4 above (instant re-fetch only wired once the
  footer already has something to show) is left as-is per the plan's literal instruction; worth a
  second look if a reviewer disagrees with that reading.

## Files touched

- New: `snufflestudy/src/sidepanel/appFooter/useIncomingActivity.ts`,
  `snufflestudy/src/sidepanel/components/NudgesAndRequestsFooter.tsx` and its `.test.tsx`.
- Deleted: `snufflestudy/src/sidepanel/components/FriendRequestPanel.tsx`.
- Edited: `snufflestudy/src/infrastructure/storage/nudgeDismissalState.ts`,
  `snufflestudy/src/sidepanel/components/friendGroupPanel/useFriendGroupPanelData.ts`,
  `snufflestudy/src/sidepanel/components/AppFooter.tsx` (+ `.test.tsx`),
  `snufflestudy/src/sidepanel/components/FriendsTab.tsx` (+ `.test.tsx`),
  `snufflestudy/src/sidepanel/components/ActiveSessionView.tsx` (+ `.test.tsx`),
  `snufflestudy/src/sidepanel/components/RequestUnlockForm.tsx`,
  `snufflestudy/src/sidepanel/SidePanelApp.tsx` (+ `.test.tsx`),
  `snufflestudy/src/background/messageRouter.ts`,
  `snufflestudy/src/infrastructure/backend/friendRequestApi.ts`,
  `snufflestudy/src/shared/messages.ts` (comment-only fixes to scrub every
  `FriendRequestPanel`/`showFriendRequestPanel` reference per the DoD's literal grep check),
  `snufflestudy/src/styles/sidepanel.css`.
