# Task 11 report — Manual QA pass

**Status: handed back.** Most of this task's own steps (2 accounts joining/nudging/dismissing each other in a real running extension, real microphone/camera hardware, a real browser profile with no popup) require a human at a keyboard, per the plan's own framing ("Two accounts... one joins... the other joins...") and per `docs/Multi_Step_Plan_Execution_Workflow.md`'s guidance to hand back any task that's genuinely a manual/human step rather than attempt it blind. What follows is: (a) everything from this task that *could* be verified programmatically, done; (b) a checklist of what's left, mapped 1:1 to the plan's own Task 11 steps, for you to run.

## What was verified programmatically (this session)

- **Full typecheck** (`npm run compile`, `tsc --noEmit`) across the whole branch: clean.
- **Full test suite** (`npx vitest run`): **891/891 passing**, 89 files, run clean (no flakes) after all 10 build tasks landed.
- **Full production build** (`npm run build`): succeeds, `.output/chrome-mv3/manifest.json` has no `action.default_popup` (Task 4 confirmed), total bundle ~2 MB, no build errors.
- **Item 8 (the one explicitly "must not be silently skipped" item):** confirmed live, not just by code inspection. Queried the live Supabase project's actual `delete_account_data()` function body (`pg_get_functiondef`) — confirmed it had **no** clause for `nudge_vault_texts` (Task 1's new table). Wrote and applied `supabase/migrations/20260815000047_v4.1_qa_delete_account_data_nudge_vault_texts.sql` (a `CREATE OR REPLACE FUNCTION` reproducing the existing body verbatim plus one new `delete from nudge_vault_texts where user_id = p_user_id;` statement), applied it via `scripts/apply-migrations.mjs`, and re-queried the live function to confirm the new clause is present. Committed as `e70be57`.
- **Migration 20260815000046** (Task 1's nudge vault schema) is confirmed live on the project (queried `information_schema` directly for `nudge_vault_texts`'s columns, `producer_tags.deleted_at`, `nudges.custom_body`/nullable `message_id`, and the `nudges_exactly_one_body` check constraint — all present).

## What's left — the plan's Task 11 steps, for you to run

Numbering matches the plan's own list (`docs/implementation_plans/V4.1_Implementation_Plan.md`, Task 11 → Steps):

1. **Fresh install, full onboarding-to-first-session path (Tasks 3, 6).** Welcome → sign-in/skip → lands on Bunny tab directly. Confirm "Study with Snuffles" exists unchecked and is the Study tab's default Goal. Run a session at the baked-in defaults (25 min / Gentle Encouragement / Soft) and confirm it actually behaves that way.
2. **No popup, anywhere (Task 4).** On a genuinely fresh browser profile (not just a reload), confirm the toolbar icon opens the side panel directly with no popup ever appearing.
3. **Study Room persistence across tabs and an active session (Task 7).** Two accounts. Join a room from Study (confirm it's no longer reachable from Friends at all). Switch every tab while joined, then start a study session while still joined — confirm the footer and the LiveKit call both survive every transition without a reconnect. Confirm leaving actually tears the call down (no zombie connection after leaving, none after closing and reopening the side panel).
4. **Nudge Vault round-trip across every send surface (Tasks 1, 7, 9).** Record an audio nudge and write a text one. Send each from the Friends box to multiple selected friends, and from the Study Room footer to multiple selected participants. Confirm delivery on the recipient's side via the new footer (Task 8) for both kinds. Delete both vault items afterward and confirm the earlier sends still display/play correctly for their recipients (Decision 1/2's whole point).
5. **Nudges & Unlock Requests footer, multiple simultaneous items (Task 8).** Generate two undismissed nudges and one pending request at once; confirm all three show together regardless of active tab; dismiss the older nudge while the newer one and the request stay visible — the specific case Decision 3 exists for (this exact case has an automated test now, per Task 8's report, but a live confirmation is still worth doing).
6. **Settings, both surfaces (Task 10).** Sidebar Settings tab: no sub-nav, described content changes present. Separately, the full Options tab: its own nav untouched, Account view lacks friend management, Friends view (`FriendSettingsFields`) still works standalone with the new seven-checkbox/Remove-friend shape.
7. **Refresh registry (Task 2).** With Study Rooms, Nudge Vault, and Nudges & Requests all showing real data, click the Header's one Refresh button and confirm every one of them re-fetches (a change on a second account/device becomes visible after the click, not only after switching tabs away and back).
8. ~~Account deletion~~ — **done above**, no longer needs a manual pass for the schema-cleanup part specifically, though a full end-to-end "delete an account with vault items, confirm everything's actually gone" pass is still worth folding into whichever of the above steps exercises account deletion.

## One other open item, carried over from Task 9's report

`FriendsPage.tsx`'s Options-page copy (a small nice-to-have, not a functional gap) was updated by Task 10 to point at the sidebar's Friends tab instead of a page section that no longer exists — already fixed, no action needed here.

## Suggested next step

Run the numbered checklist above against a real build (`npm run build` in `snufflestudy/`, load `.output/chrome-mv3` unpacked in Chrome) with two real accounts. Nothing found should require touching more than one task's own files, given how cleanly each task's own report says it verified against the others — but this is the pass that would catch anything the per-task static verification couldn't (real LiveKit behavior, real microphone permission prompts, real cross-tab timing).
