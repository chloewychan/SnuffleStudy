// Sends the email delivery leg of a temp-passcode request.
//
// Request: { requestId: string } - invoked by tempPasscodeApi.ts's createRequest() immediately
// after the friend_requests row is inserted (fire-and-forget from the client's perspective -
// createRequest never awaits this call before resolving).
//
// This is one flow with two delivery paths, and the in-app leg needs NO separate write from this
// function at all: the friend_requests row already exists and is already visible to
// friend_user_id the instant it's inserted, via that table's RLS policy letting the requester's
// assigned friend read their own pending friend requests. alarmHandlers.ts's friend-poll alarm is
// what turns that visibility into an actual chrome.notifications toast on the friend's device.
// This function's entire job is the OTHER delivery path: the email.
//
// Reads RESEND_API_KEY via Deno.env.get(...) only - never logged, never echoed in a response.
// Uses SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY, auto-injected into every
// Edge Function's environment by Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// `hostname` reaches this function entirely caller-controlled - messageRouter.ts passes whatever
// the side panel sent, tempPasscodeApi.ts's createRequest() inserts it verbatim, and
// friend_requests.hostname carries no CHECK constraint bounding its shape. Interpolating it raw
// into the outbound email's HTML body would let an authenticated user have arbitrary
// attacker-authored markup delivered to another user's real inbox from this product's sending
// domain, so it must be escaped before interpolation.
//
// A hostname is a plain string rendered as text, never rich content, so full escaping of the five
// HTML-significant characters is both sufficient and complete - there is deliberately no allowlist
// or partial-passthrough here. `&` must be replaced first, or it would double-escape the
// ampersands introduced by the later replacements.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Hoisted to module scope so a warm Deno isolate reuses the same clients across invocations
// instead of reconstructing them every request.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const anonClient =
  SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const adminClient =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

interface RequestBody {
  requestId?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    if (!anonClient || !adminClient) {
      console.error("Missing Supabase environment configuration");
      return json({ error: "Server misconfigured" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Not authenticated" }, 401);
    }
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userData, error: userError } = await anonClient.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not authenticated" }, 401);
    }
    const callerId = userData.user.id;

    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.requestId) {
      return json({ error: "Missing requestId" }, 400);
    }

    // Re-derived server-side via the service-role client, never trusted from the request body -
    // same discipline approve-temp-passcode/redeem-temp-passcode use for their own row lookups.
    const { data: row, error: rowError } = await adminClient
      .from("friend_requests")
      .select("id, hostname, requester_user_id, friend_user_id")
      .eq("id", body.requestId)
      .eq("kind", "site_temp_pass")
      .single();
    if (rowError || !row) {
      return json({ error: "Request not found" }, 404);
    }
    // Only the requester who just created this row can trigger its own notification email - a
    // defense-in-depth check (this function is only ever actually called from createRequest right
    // after the insert, but nothing stops a different authenticated caller from guessing/reusing a
    // requestId otherwise).
    if (row.requester_user_id !== callerId) {
      return json({ error: "Not authorized for this request" }, 403);
    }

    const { data: friendUser, error: friendError } = await adminClient.auth.admin.getUserById(
      row.friend_user_id
    );
    const friendEmail = friendUser?.user?.email;
    if (friendError || !friendEmail) {
      console.error("Could not resolve the assigned friend's email", friendError);
      // Not a hard failure for the caller - the in-app leg (the row itself) already succeeded
      // regardless of whether we can find an email address to send to.
      return json({ ok: true, emailSent: false }, 200);
    }

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) {
      console.error("RESEND_API_KEY is not configured");
      return json({ ok: true, emailSent: false }, 200);
    }

    // Per https://resend.com/docs/api-reference/emails/send-email: POST /emails,
    // Authorization: Bearer <key>, JSON body { from, to, subject, html }. `onboarding@resend.dev`
    // is Resend's shared sandbox sending domain - it typically can only deliver to the Resend
    // account owner's own verified email until a custom domain is DNS-verified. That's an
    // expected, known limitation of this environment, not something this function works around -
    // a failed/rejected send here is logged and reported as emailSent: false, never thrown as a
    // hard error (the in-app leg via the row itself is unaffected either way).
    let emailSent = false;
    try {
      const resendResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: "SnuffleStudy <onboarding@resend.dev>",
          to: [friendEmail],
          subject: "A friend needs a temporary passcode",
          // `row.hostname` is the only user-controlled value interpolated into this body (the rest
          // is static copy, and `friendEmail` goes into the `to` array as JSON, never into the
          // HTML) - escaped per escapeHtml's comment above.
          html:
            `<p>A friend on SnuffleStudy is asking you to unlock <strong>${escapeHtml(
              row.hostname
            )}</strong> ` +
            "for a limited time during their focus session.</p>" +
            "<p>Open SnuffleStudy's side panel to review and approve or deny this request.</p>",
        }),
      });
      if (!resendResponse.ok) {
        const errText = await resendResponse.text().catch(() => "");
        console.error(`Resend API error ${resendResponse.status}: ${errText}`);
      } else {
        emailSent = true;
      }
    } catch (err) {
      console.error("Failed to call Resend API", err);
    }

    return json({ ok: true, emailSent }, 200);
  } catch (err) {
    console.error("send-temp-passcode-request crashed", err);
    return json({ error: "Internal error" }, 500);
  }
});
