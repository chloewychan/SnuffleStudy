# Implementation Plan Writing Guidelines

Use this when asked to write a version/phase implementation plan for this project (e.g., "create the v3 implementation plan"). It's the standing answer to "how detailed should this be" — read it before deciding, don't default to matching whatever the previous plan looked like.

## Core principle

Detail level tracks how well-understood the work is, not a fixed density and not "however detailed the last plan was." Before writing each task, ask: is this internal and deterministic — do I actually know the exact right answer — or is it new/integration-heavy, where the right answer depends on an external API that may have changed, or a genuine judgment call?

## Always include, at any detail level

- **An `Interfaces: Consumes/Produces` block per task**, even in a lightweight plan. Name the exact function signatures, type names, and message/event shapes a task produces that later tasks depend on. This is the single highest-value, lowest-cost addition — it's what stops independently-executed tasks (especially across separate subagent sessions) from inventing incompatible shapes for the same concept.
- **A concrete, checkable Definition of Done per task** — a specific scenario and expected result someone could actually verify, not "works correctly."
- **A `Decisions` section up front** for anything genuinely ambiguous or judgment-call. Resolve it once, in the plan, flagged as overridable — don't leave it to be improvised independently by whichever task or agent hits it first. Deciding it in the plan means the user reviews it once, before code exists; deciding it during execution means the user finds out after code exists, from whatever an executor happened to choose.
- **An explicit Scope section** — in scope, and just as importantly, explicitly out of scope — so "not mentioned" isn't silently read as either "build it anyway" or "definitely cut."

## Go full-detail (exact code/types, TDD-style — matching `docs/V1_Implementation_Plan.md`'s density) for

- Internal domain logic with no external dependency: state machines, pure calculations, data validation.
- Anything built on a stable, well-known API you're actually confident hasn't changed: standard Chrome extension APIs, Web Crypto, well-established libraries.
- Any type/schema/contract shared across more than one task. Get this exactly right once — every consumer inherits it, and a mismatch here is the most expensive class of bug to find later.
- Security- or privacy-critical logic: access control, secret handling, anything hashing or verifying credentials. Write explicit negative-case verification ("authenticate as an unauthorized party, attempt to read/write X, it must fail") — not just a happy-path check.

## Go light (goal + contract only, no exact call syntax) for

- Fast-moving third-party SDKs and APIs — payment providers, video/calling SDKs, LLM APIs, email providers, anything with a changelog. Pin the *contract* (inputs, outputs, error/timeout behavior, where secrets live) and say explicitly that exact call syntax should be confirmed against current docs at implementation time. Writing remembered exact syntax here is worse than admitting the gap: a wrong-but-confident code sample gets implemented faithfully by a trusting executor, while a stated "check current docs" actually gets checked.
- Anything not actually settled yet — an unresolved product call, an unpicked vendor. Make the call, log it as a Decision, move on. Don't write detailed code around a choice that might get reversed.

## Don't confuse "less code in the plan" with "less rigor"

A shorter plan is fine when the work is well-scoped and low-risk. It's not fine when it's shorter because writing the Interfaces contracts or the security verification criteria got skipped. Optimize for total cost across the whole lifecycle — writing the plan, executing it, fixing what breaks — not for the plan document's line count. A dense, precise-looking plan for genuinely uncertain work can cost *more* than it saves if the precision is fake.

## Structure to reuse

Header (Goal / Architecture / Tech Stack / Global Constraints) → `Decisions` → `Scope` (in/out) → file-structure diagram → phase-ordered `Build order` → per-task blocks (Goal / Depends on / Interfaces / Deliverables-or-Steps / Definition of done) → whole-version `Definition of done` → `Self-review` (spec coverage against the scope doc + dependency consistency check).
