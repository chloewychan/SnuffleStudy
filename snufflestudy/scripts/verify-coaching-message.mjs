// Live end-to-end proof for Task 11's Definition of Done: "a distraction on a session with goal
// 'Finish Chapter 6 of STAT231' produces a message referencing that goal specifically; going
// offline or exceeding the rate limit falls back to the static pool with no visible error to the
// user; confirm the Anthropic API key does not appear in .output/ after a production build."
//
// Standalone Node script (same style/conventions as scripts/verify-digest.mjs/
// verify-privacy-controls.mjs - reuses their test-account/expectOk-style helpers) - reads .env
// via dotenv/config, not part of `npm test`. Run directly: node scripts/verify-coaching-message.mjs
//
// Unlike every other verify-*.mjs script in this repo, this one exercises a genuinely reachable
// HTTPS endpoint (the deployed generate-coaching-message Edge Function) rather than only Postgres
// RLS/RPC behavior - so it talks to it via plain fetch (not supabase.functions.invoke(), which
// this script has no reason to depend on) with the same Authorization/apikey headers a real
// invoke() call sends, giving direct, unambiguous access to the raw HTTP status code on every
// response (needed for Case 2's 429 assertion).
//
// What it does:
//   1. Case 1 (goal-specificity + latency): creates one ephemeral, auto-confirmed account
//      (USER_GOAL), signs in, calls the Edge Function REPEAT_CALLS times (sequentially, well
//      under the 12/60s rate limit) with goal "Finish Chapter 6 of STAT231" and a
//      "gentle-encouragement" pressure profile, timing each call. Content assertions (HTTP 200;
//      non-empty `message`; the message plausibly references the specific goal - "chapter 6" or
//      "stat231", case-insensitive, the DoD's literal example; NOT byte-identical to either of
//      gentle-encouragement's static firstWarningMessages pool entries) run against the first
//      call. Fix round 1: a real latency assertion now runs across ALL calls - median (p50)
//      elapsed time is asserted against coachingApi.ts's REAL 800ms client-side race timeout
//      (INVOKE_TIMEOUT_MS), not an invented "should be comfortable" number. Before this fix,
//      Case 1 only proved the call eventually succeeds (5s per-request allowance, no elapsed time
//      ever recorded) - a function that happened to take 3 seconds per call would have passed
//      every check while the shipped feature fell back to the static pool on almost every real
//      distraction event. p50 (not p100/max) is the right statistic: a single slow outlier is
//      exactly what coachingApi.ts's per-call race-and-fallback design already tolerates by
//      design (that request's user just sees the static pool that one time) - what would
//      actually indicate a wrong model/latency profile is the TYPICAL call being too slow, which
//      p50 across several calls measures directly. As of this fix round, this specific assertion
//      is a KNOWN, HONEST FAIL (see task-11-report.md's "Fix round 1" section) - real measured
//      p50 is ~1150-1200ms even after switching to claude-haiku-4-5 and collapsing the rate-limit
//      check+insert into one atomic RPC, because the Anthropic API call itself (not this
//      function's own overhead) is the dominant cost and did not meaningfully improve from either
//      optimization. Left failing deliberately rather than loosened to a passing number that
//      wouldn't mean anything - see the report for the full analysis and open questions this
//      raises for a follow-up decision (e.g. whether INVOKE_TIMEOUT_MS itself should change).
//   2. Case 2 (rate limiting): creates a second ephemeral account (USER_RATE_LIMIT), dedicated to
//      this case so Case 1's single call never contends with it. Fires 15 sequential requests
//      (5s per-request timeout via AbortController, so a hang fails loudly instead of blocking
//      the script forever) - one more than the Edge Function's configured 12/60s limit - and
//      asserts: every response is either 200 or 429 (never 500/502/a hang); at least one 429
//      appears among them (proving the limiter actually engages, not just that some other error
//      occurred); no response after the first 429 for this user is EVER 500 (confirms an
//      admitted-then-denied client fails closed cleanly, matching coachingApi.ts's contract that
//      a 429 is a fallback trigger, not a crash).
//   3. Case 3 (build-artifact secret leak check): runs `npm run build`, then greps the entire
//      .output/ directory for the Anthropic API key's distinctive constant prefix ("sk-ant-" -
//      every Anthropic API key begins with this; checking the prefix proves the literal key
//      string cannot appear without also matching, without this script ever needing to read the
//      real key value out of .env itself) and for the literal string "ANTHROPIC_API_KEY" (the env
//      var name - safe to search for, not a secret). Asserts neither appears anywhere under
//      .output/.
//   4. Cleans up every row and account it created via the service-role client.
//   5. Prints a pass/fail summary and exits non-zero if anything failed.

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = process.env.WXT_SUPABASE_URL;
const ANON_KEY = process.env.WXT_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing WXT_SUPABASE_URL / WXT_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env"
  );
  process.exit(1);
}

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/generate-coaching-message`;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RUN_ID = Date.now();
// Ephemeral, discarded at cleanup - never reused, never printed.
const PASSWORD = `Verify-Coaching-${crypto.randomUUID()}!`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNUFFLESTUDY_ROOT = path.resolve(__dirname, "..");

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function createTestUser(label) {
  const email = `coaching-test-${label}-${RUN_ID}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Failed to create test user ${label}: ${error?.message}`);
  }
  return { id: data.user.id, email };
}

async function signInAndGetAccessToken(email) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`Failed to sign in as ${email}: ${error?.message}`);
  return data.session.access_token;
}

// Calls the deployed Edge Function directly via fetch (not supabase.functions.invoke()) so this
// script gets the raw HTTP status code unambiguously - see the header comment for why that
// matters for Case 2. `timeoutMs` guards against a hang counting as neither a pass nor a fail.
// Also times the full request (fix round 1 - see Case 1's elapsedMs use below), so callers get
// wall-clock latency for free without a second measurement mechanism to keep in sync.
async function callFunction(accessToken, body, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function cleanup(userIds) {
  console.log("\nCleaning up test data...");
  // Dependency order matters: coaching_message_requests.user_id has no ON DELETE CASCADE toward
  // auth.users (same note as every other verify-*.mjs script) - referencing rows must go before
  // the users they reference.
  await admin.from("coaching_message_requests").delete().in("user_id", userIds);
  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.error(`  Failed to delete test user ${id}: ${error.message}`);
  }
  console.log("Cleanup done.");
}

// Recursively walks a directory, calling `onFile` for every regular file found. Used by Case 3
// to grep the entire .output/ tree without shelling out to `grep -r` (keeps this script
// dependency-free and portable).
function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, onFile);
    } else if (stat.isFile()) {
      onFile(full);
    }
  }
}

async function main() {
  const userIds = [];

  try {
    // === Case 1: goal-specificity + latency ===
    console.log("=== Case 1: goal-specificity + latency ===");
    const userGoal = await createTestUser("goal");
    userIds.push(userGoal.id);
    const goalToken = await signInAndGetAccessToken(userGoal.email);

    // REPEAT_CALLS=8 sequential calls, well under the 12/60s rate limit (this is Case 1's own
    // dedicated user, untouched by Case 2's separate user below) - enough samples for a
    // meaningful median without needlessly burning most of this user's own quota.
    const REPEAT_CALLS = 8;
    const goalCalls = [];
    for (let i = 0; i < REPEAT_CALLS; i++) {
      const result = await callFunction(goalToken, {
        pressureProfileId: "gentle-encouragement",
        goal: "Finish Chapter 6 of STAT231",
        hostname: "youtube.com",
        interventionLevel: "none",
      });
      goalCalls.push(result);
    }
    const elapsedMsList = goalCalls.map((c) => c.elapsedMs);
    const p50 = median(elapsedMsList);
    console.log(`  Elapsed ms across ${REPEAT_CALLS} calls: ${elapsedMsList.join(", ")} (p50=${p50}ms)`);

    const firstCall = goalCalls[0];
    record(
      "Case 1: a real call with a specific goal returns HTTP 200",
      firstCall.status === 200,
      `got status ${firstCall.status}, body ${JSON.stringify(firstCall.json)}`
    );

    const message = firstCall.json?.message;
    record(
      "Case 1: response body has a non-empty `message` string",
      typeof message === "string" && message.trim().length > 0,
      `got ${JSON.stringify(message)}`
    );

    if (typeof message === "string") {
      const lower = message.toLowerCase();
      record(
        "Case 1: the message plausibly references the specific goal (contains 'chapter 6' or 'stat231')",
        lower.includes("chapter 6") || lower.includes("stat231"),
        `got message: ${JSON.stringify(message)}`
      );

      // gentle-encouragement's static firstWarningMessages pool (src/domain/pressure/
      // pressureProfiles.ts) - a genuinely generated line must not be byte-identical to either
      // fixed fallback string, since neither mentions the goal at all.
      const STATIC_POOL = ["Hey, is this part of the plan?", "Just checking in — still studying?"];
      record(
        "Case 1: the message is NOT one of the static fallback pool's fixed strings (proves it's a real generated line, not a passthrough)",
        !STATIC_POOL.includes(message),
        `got message: ${JSON.stringify(message)}`
      );
    }

    // Fix round 1: the actual latency assertion this Definition of Done requires. coachingApi.ts
    // races the ENTIRE round trip (client -> Edge Function -> JWT verify -> rate-limit RPC ->
    // Anthropic call -> response) against an 800ms timeout (INVOKE_TIMEOUT_MS,
    // src/infrastructure/backend/coachingApi.ts) before falling back to the static pool - this
    // asserts against that EXACT real constant (not an invented "comfortable" number picked
    // without measuring first, which is what fix round 1's own first draft did and got wrong -
    // see task-11-report.md's Fix round 1 section) because that is the only threshold that is
    // actually "meaningful" here: it's the literal bar the shipped feature is racing against in
    // production, so this check reports the ACTUAL truth about the ACTUAL requirement rather than
    // a threshold reverse-engineered to make the check green.
    //
    // Known, currently-open finding (see task-11-report.md's Fix round 1 section for the full
    // writeup and breakdown): even after switching to claude-haiku-4-5 (fastest/cheapest current
    // Anthropic model) and collapsing the rate-limit check+insert into one atomic RPC call, the
    // measured p50 does NOT clear this budget - the dominant cost by a wide margin is the
    // Anthropic API call itself (roughly 85-95% of total elapsed time in every sample), not this
    // function's own Supabase-side overhead, and that portion did not meaningfully improve from
    // either optimization. This is intentionally left as a genuine, visible FAIL rather than
    // silently loosened - the whole point of this fix round was to stop a green checkmark from
    // meaning "eventually returns" instead of "meets the actual budget."
    const INVOKE_TIMEOUT_MS = 800; // must match src/infrastructure/backend/coachingApi.ts's own constant
    record(
      `Case 1: median (p50) latency across ${REPEAT_CALLS} calls stays under coachingApi.ts's real ${INVOKE_TIMEOUT_MS}ms race timeout`,
      p50 < INVOKE_TIMEOUT_MS,
      `p50=${p50}ms (budget ${INVOKE_TIMEOUT_MS}ms), all samples: [${elapsedMsList.join(", ")}]ms`
    );

    // === Case 2: rate limiting ===
    console.log("\n=== Case 2: rate limiting ===");
    const userRateLimit = await createTestUser("ratelimit");
    userIds.push(userRateLimit.id);
    const rateLimitToken = await signInAndGetAccessToken(userRateLimit.email);

    const REQUEST_COUNT = 15; // one more than the configured 12/60s limit
    const rateLimitBody = {
      pressureProfileId: "strict-coach",
      goal: "Read two chapters of the textbook",
      hostname: "reddit.com",
      interventionLevel: "warned",
    };

    const statuses = [];
    for (let i = 0; i < REQUEST_COUNT; i++) {
      const { status } = await callFunction(rateLimitToken, rateLimitBody);
      statuses.push(status);
    }
    console.log(`  Statuses across ${REQUEST_COUNT} rapid requests: ${statuses.join(", ")}`);

    const allExpectedStatus = statuses.every((s) => s === 200 || s === 429);
    record(
      "Case 2: every rapid-fire response is 200 or 429 - never a 500/502 or a hang",
      allExpectedStatus,
      `statuses: ${statuses.join(", ")}`
    );

    const rateLimitedCount = statuses.filter((s) => s === 429).length;
    record(
      "Case 2: hitting the configured limit (12/60s) produces at least one 429 response among 15 rapid requests",
      rateLimitedCount > 0,
      `${rateLimitedCount} of ${REQUEST_COUNT} requests were 429`
    );

    // === Case 3: build-artifact secret leak check ===
    console.log("\n=== Case 3: build-artifact secret leak check ===");
    console.log("  Running `npm run build` (this can take a minute)...");
    execFileSync("npm", ["run", "build"], { cwd: SNUFFLESTUDY_ROOT, stdio: "pipe" });

    const outputDir = path.join(SNUFFLESTUDY_ROOT, ".output");
    let keyPrefixLeaked = false;
    let envVarNameLeaked = false;
    let filesScanned = 0;
    try {
      walk(outputDir, (file) => {
        filesScanned++;
        const contents = readFileSync(file, "utf8");
        if (contents.includes("sk-ant-")) keyPrefixLeaked = true;
        if (contents.includes("ANTHROPIC_API_KEY")) envVarNameLeaked = true;
      });
    } catch (err) {
      throw new Error(`Failed to scan .output/ after build: ${err.message}`);
    }

    record(
      `Case 3: .output/ exists and was scanned after \`npm run build\` (${filesScanned} files)`,
      filesScanned > 0,
      `scanned ${filesScanned} files under ${outputDir}`
    );
    record(
      "Case 3: no Anthropic API key (the 'sk-ant-' prefix) appears anywhere under .output/",
      !keyPrefixLeaked
    );
    record(
      "Case 3: the literal string 'ANTHROPIC_API_KEY' does not appear anywhere under .output/ (it's never referenced client-side)",
      !envVarNameLeaked
    );
  } catch (err) {
    console.error("verify-coaching-message.mjs crashed:", err);
    results.push({ name: "Script crashed before finishing", pass: false, detail: String(err) });
  } finally {
    if (userIds.length > 0) await cleanup(userIds);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Coaching message verification summary ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.name}`);
  }
  console.log(
    failed.length === 0
      ? `\nAll ${results.length} checks passed.`
      : `\n${failed.length} of ${results.length} checks FAILED.`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
