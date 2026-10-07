// A static, informational privacy policy bundled into the extension's own options surface (no
// external hosting). The content below describes this app's actual data flows, confirmed
// against this codebase's own storage/backend code, not generic boilerplate - but it is not
// exact legal copy. Privacy-policy wording is a product/legal judgment call; this page should
// be reviewed by a human with that context before any real Chrome Web Store submission,
// particularly for exact regulatory phrasing (GDPR/CCPA-style rights language, a real contact
// address/mechanism, and a genuine "last updated" process).
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
            audio nudges: your friend connections, invite codes, per-friend privacy
            toggles, generic session-status events (session started/paused/distracted/completed,
            etc. - never a site name or your goal text, and only synced at all if you turn on
            "Share session activity" in Settings), unlock requests and temporary-passcode
            requests you send or receive, study rooms and who's in them, audio nudge metadata and
            who you sent one to, your daily digest numbers, nudges, and a short-lived rate-limit
            timestamp for the AI coaching feature (see Anthropic, below).
          </li>
          <li>
            <strong>Storage</strong> - audio nudge recordings: short voice clips you record and
            send to friends or into a study room.
          </li>
          <li>
            <strong>Realtime</strong> - used to deliver live presence and audio nudge broadcasts
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
          table above tied to your account, your audio nudge recordings from Storage, and your
          account itself - irreversibly. On-device data (chrome.storage.local, IndexedDB) is
          separate and local; uninstalling the extension removes that.
        </p>
      </section>
    </div>
  );
}
