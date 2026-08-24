# Workflow: Executing a Multi-Task Implementation Plan with Fresh Agents

A reusable pattern for turning a written implementation plan into working code without one session's context ballooning across every task. Built from actually testing it (verified a spawned subagent can reach the same repo I can, via the same device connection) rather than assumed.

---

## When this applies

You have (or are about to write) an implementation plan broken into discrete tasks, each with real interdependencies (Task 3 needs Task 1's output, etc.), and the whole plan is too big to comfortably execute in one continuous session without either running out of context or paying a growing "resend the whole history" tax on every turn.

If your plan is 2–3 small, tightly coupled tasks, this is overkill — just do it in one session. This pays off once you're past roughly 4–5 tasks, or any task involves enough file reading/editing that its own transcript would be expensive to keep dragging through every later turn.

---

## Prerequisite: the plan has to be written for this

The whole pattern only works if each task is a **self-contained brief** — because the agent executing it starts fresh, with no memory of the planning conversation. Before using this workflow, check that every task block in your plan has:

- **A clear goal** — one or two sentences, no ambiguity about what "done" means.
- **Explicit dependencies** — which earlier tasks must be finished first, and *why* (what it actually reads or builds on, not just a formal ordering).
- **Interfaces** — exact function signatures, types, message shapes, or API contracts the task consumes and produces. This is what lets Task 4 build correctly on Task 2's work without needing to re-derive it.
- **Concrete deliverables** — specific files, specific changes, not "improve X."
- **A definition of done** — something checkable, ideally by running a command, not just "looks right."

If a task is missing these, fresh agents will guess — sometimes correctly, sometimes not, and inconsistently across tasks. Tighten the plan first; it's cheaper than debugging a subagent's wrong guess.

---

## The per-task loop

Repeat this for each task, in dependency order:

1. **Start fresh.** A new subagent (spawned by an orchestrating session) or a brand-new session/terminal — either works; see "Two ways to run it" below.
2. **Brief it narrowly:** point it at the plan doc and name exactly one task. Don't hand it the whole planning conversation — the plan doc *is* the brief.
3. **Make it verify before it trusts.** Explicitly instruct it to check the plan's claims about current file/repo state against the actual files, not just act on the plan's prose. Plans go stale the moment code changes underneath them — this exact thing happened twice while writing the plan this pattern is drawn from.
4. **Let it implement, build, and test** — not just write code, but confirm the task's definition of done actually holds.
5. **Have it write a short report** — what it built, any judgment calls or deviations from the plan (and why), what it verified, what's still open. This report is the hand-off artifact for the *next* task, instead of relying on anyone's memory of this conversation.
6. **You (or the orchestrating session) review the diff and the report before moving on.** Don't chain tasks automatically on trust — a subagent's own summary of its work is a claim, not a verification.
7. **Commit**, then move to the next task.

---

## Reusable prompt template

Copy this in for each task. Fill in the brackets.

```
You are implementing Task [N] of [path to implementation plan]. Before making any changes:

1. Read Task [N]'s full block, plus the plan's Decisions and Scope sections for context.
2. Independently verify the plan's claims against the CURRENT state of the repo — do not
   trust the plan's prose about file contents, branch state, or what prior tasks left behind.
   Read the actual files. If something in the plan is stale or wrong, say so and correct your
   approach rather than silently working around it or silently following the stale version.
3. Confirm Task [N]'s "Depends on" line is actually satisfied right now, not just assumed from
   the plan's ordering.
4. Implement exactly what the task's Deliverables section specifies.
5. Verify the Definition of Done — run whatever you can programmatically; verify the rest
   manually and say how you did it.
6. Write a short report to [report path, e.g. task-N-report.md]: what you built, any judgment
   calls or deviations from the plan and why, what you verified, what's still open.
7. Do not start work on any other task, and do not modify files outside this task's scope.
```

---

## Two ways to run it

**A. Separate sessions you start yourself** (e.g. a fresh terminal running Claude Code, once per task). Fully isolated, no ambiguity about what's in context, and the most battle-tested version of this — it's how earlier versions of the SnuffleStudy repo were apparently actually built (there are per-task report files already in its history). You drive the sequencing.

**B. One orchestrating session dispatching subagents.** You stay in one conversation; that session spawns a fresh subagent per task using the prompt template above, reviews each result, commits, and moves on. More convenient — you don't have to manually relaunch and re-orient each time — and I've now confirmed a subagent I spawn can reach the same live connection to your repo that I can. The orchestrating session's own context stays flat throughout, since only each subagent's final report re-enters it, not its full transcript.

Either way, the discipline is the same: fresh context per task, narrow brief, verify-before-trust, report, review, commit.

---

## Sequencing and parallelism

- Default to strictly sequential, in the plan's dependency order.
- Only run two tasks in parallel if you've explicitly confirmed they touch no files in common — don't assume from the plan's prose, check it (`grep`/`git diff --stat` against what each task's deliverables list). Two tasks editing the same file concurrently is exactly how repos end up with unresolved conflicts or, if you're on a sync service like iCloud/Dropbox, spurious duplicate files.
- A plan with heavy interdependencies (most files touched by multiple tasks) won't have much to parallelize, and that's fine — the benefit of this workflow isn't parallel speed, it's keeping context and token cost from compounding.

---

## Why this actually saves tokens

Not because any individual task gets cheaper — reading and editing the same files costs roughly the same no matter who's doing it. The saving is in what *doesn't* get re-paid:

- In one continuous session, every new turn resends the entire conversation so far. By task 8 of 9, you're re-paying for tasks 1–7's file dumps, edits, and test output on every single turn — cost compounds roughly with the amount of work already done, not just the work in front of you.
- Once that session's context fills up, it forces a summarization pass to keep going — which is lossy. Details get compressed or dropped, and you end up re-verifying things that were already established.
- Fresh sessions/subagents per task avoid both: each task's cost is roughly independent of how many tasks came before it, and nothing ever needs to be compacted away.

The fixed cost of *starting* a fresh agent (loading its instructions and tool definitions before it does anything) is real but small relative to an actual multi-file implementation task — it's not worth avoiding for tasks of this size. It only matters if you're tempted to spin up a fresh agent for something trivial (a one-line fix), where the startup cost can exceed the task itself.

---

## Quick checklist

- [ ] Plan has explicit goal / dependencies / interfaces / deliverables / definition-of-done per task
- [ ] Tasks ordered by real dependency, not just document order
- [ ] Decided: separate sessions you start, or one session dispatching subagents
- [ ] Per task: fresh context → narrow brief → verify-before-trust → implement → test → report → review → commit
- [ ] Parallelize only confirmed disjoint-file task pairs
- [ ] Report files persisted somewhere (not just conversation memory) as the hand-off between tasks
