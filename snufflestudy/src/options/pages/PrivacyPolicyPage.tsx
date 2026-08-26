// v3.2 Task 8: Privacy policy.
//
// A static, informational page bundled into the extension's own options surface (no external
// hosting available/verifiable from this sandbox - see this task's report for the reasoning).
// Every destination named below was confirmed directly against this codebase's actual code
// before being written, not assumed from a generic template:
//   - chrome.storage.local: grepped every call site (chromeStorageRepository.ts, friendPollState.ts,
//     supabaseClient.ts's own storage adapter) - settings, the active session snapshot, the
//     hard-block passcode credential, and per-feature poll-cursor timestamps.
//   - IndexedDB: grepped every `openDB(...)` call - two local databases, "snufflestudy"
//     (indexedDbRepository.ts: session history + session events) and "snufflestudy-tasks"
//     (taskRepository.ts: tasks).
//   - Supabase Postgres table list: the same fourteen-table audit this task's account-deletion
//     migration documents (supabase/migrations/20260815000032_v3.2_account_deletion.sql).
//   - Anthropic: read supabase/functions/generate-coaching-message/index.ts in full - confirms the
//     goal text and distracting hostname are sent, per-request, in the prompt body.
//   - Resend: read supabase/functions/send-temp-passcode-request/index.ts in full - confirms the
//     friend's email and the requested hostname are sent.
//   - LiveKit: read supabase/functions/generate-livekit-token/index.ts in full - confirms only a
//     short-lived (1 hour) signed token scoped to the caller's own id and room is minted; actual
//     audio/video streams go directly from the browser to LiveKit's infrastructure, never through
//     Supabase.
//
// This is written as accurate, specific, real content about this app's actual data flows - not
// exact legal copy. Per this task's own framing (and this project's Implementation Plan
// Guidelines), privacy-policy wording is a product/legal judgment call; this page should be
// reviewed by a human with that context before any real Chrome Web Store submission, particularly
// for exact regulatory phrasing (GDPR/CCPA-style rights language, a real contact
// address/mechanism, and a genuine "last updated" process) that this implementation session has
// no authority to originate.
export function PrivacyPolicyPage() {
  return (
    <div className="privacy-policy-page">
      <h2>Privacy policy</h2>
      <p>
        <em>
          This page describes what SnuffleStudy actually does with your data, in plain terms.
          Review it alongside the Account page's "Delete account" action, which removes everything
          listed here as belonging to your account.
        </em>
      </p>

      <section>
        <h3>On this device</h3>
        <ul>
          <li>
            <strong>chrome.storage.local</strong> - your extension settings, a snapshot of your
            currently active study session, your hard-block passcode (stored as a hash, not
            plaintext), and small timestamps this extension uses to know when it last checked for
            friend activity.
          </li>
          <li>
            <strong>IndexedDB</strong> - your full session history and per-session events (one
            local database), and your tasks (a second local database).
          </li>
        </ul>
        <p>
          None of this leaves your device unless a specific feature below sends it somewhere -
          most of it never does. Uninstalling the extension removes it.
        </p>
      </section>

      <section>
        <h3>Supabase (our backend)</h3>
        <p>
          SnuffleStudy uses Supabase for accounts, the social/accountability features, and file
          storage. You only send data here at all if you sign in.
        </p>
        <ul>
          <li>
            <strong>Auth</strong> - your email address, used only for email one-time-code sign-in.
          </li>
          <li>
            <strong>Postgres (database)</strong> - if you add friends, use study rooms, or
            Producer Tags: your friend connections, invite codes, per-friend privacy
            toggles, generic session-status events (session started/paused/distracted/completed,
            etc. - never a site name or your goal text, and only synced at all if you turn on
            "Share session activity" in Settings), unlock requests and temporary-passcode
            requests you send or receive, study rooms and who's in them, Producer Tag metadata and
            who you sent a tag to, your daily digest numbers, nudges, and a short-lived rate-limit
            timestamp for the AI coaching feature (see Anthropic, below).
          </li>
          <li>
            <strong>Storage</strong> - Producer Tag audio: short voice clips you record and send
            to friends or into a study room.
          </li>
          <li>
            <strong>Realtime</strong> - used to deliver live presence and Producer Tag broadcasts
            inside a study room while you're in it; not separately persisted beyond the Postgres
            rows above.
          </li>
        </ul>
      </section>

      <section>
        <h3>Anthropic (Claude), server-side only</h3>
        <p>
          If you're signed in and get distracted during a focus session, SnuffleStudy can ask an
          Anthropic model to generate a short, in-character coaching line. To do that, the request
          (handled entirely on our server - your device never talks to Anthropic directly) sends
          Anthropic your study goal's text and the hostname of the site you got distracted on,
          purely to generate that one sentence. SnuffleStudy does not store this text beyond a
          short per-request rate-limit timestamp; handling of the request itself is subject to
          Anthropic's own API data-use terms.
        </p>
      </section>

      <section>
        <h3>Resend (email), server-side only</h3>
        <p>
          If you request a temporary passcode from a friend to unlock a site during a locked
          session, SnuffleStudy emails that friend (via Resend) to let them know, including the
          hostname you're asking to unlock. This only happens when you initiate that request.
        </p>
      </section>

      <section>
        <h3>LiveKit (video/audio calls)</h3>
        <p>
          Joining a Study Room mints a short-lived (one hour), single-use access token scoped to
          your identity and that specific room. Your camera and microphone connect directly to
          LiveKit's video infrastructure for the call itself - SnuffleStudy's own servers never
          see or store your audio/video stream.
        </p>
      </section>

      <section>
        <h3>What we don't do</h3>
        <p>
          No analytics or advertising trackers, no selling your data, no browsing history sent
          anywhere unless you explicitly opt into "Share session activity" with your own friends
          - and even then, only generic event types, never site names or your goal text.
        </p>
      </section>

      <section>
        <h3>Deleting your data</h3>
        <p>
          The Account page's "Delete account" action permanently removes every row across every
          table above tied to your account, your Producer Tag audio from Storage, and your account
          itself - irreversibly. On-device data (chrome.storage.local, IndexedDB) is separate and
          local; uninstalling the extension removes that.
        </p>
      </section>
    </div>
  );
}
