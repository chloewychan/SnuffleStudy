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
//   1. Case 1 (goal-specificity): creates one ephemeral, auto-confirmed account (USER_GOAL),
//      signs in, calls the Edge Function once with goal "Finish Chapter 6 of STAT231" and a
//      "gentle-encouragement" pressure profile. Asserts: HTTP 200; a non-empty `message` string;
//      the message plausibly references the specific goal (contains "chapter 6" or "stat231",
//      case-insensitive - the DoD's literal example); the message is NOT byte-identical to either
//      of gentle-encouragement's static firstWarningMessages pool entries (proving it's a real
//      generated line, not an accidental passthrough of the fallback pool).
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
async function callFunction(accessToken, body, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
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
    // === Case 1: goal-specificity ===
    console.log("=== Case 1: goal-specificity ===");
    const userGoal = await createTestUser("goal");
    userIds.push(userGoal.id);
    const goalToken = await signInAndGetAccessToken(userGoal.email);

    const goalResult = await callFunction(goalToken, {
      pressureProfileId: "gentle-encouragement",
      goal: "Finish Chapter 6 of STAT231",
      hostname: "youtube.com",
      interventionLevel: "none",
    });

    record(
      "Case 1: a real call with a specific goal returns HTTP 200",
      goalResult.status === 200,
      `got status ${goalResult.status}, body ${JSON.stringify(goalResult.json)}`
    );

    const message = goalResult.json?.message;
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
