import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StudyTab } from "./StudyTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";
import type { Task } from "../../domain/tasks/taskTypes";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("StudyTab", () => {
  it("renders both the session setup form and the task vault", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [] });

    render(<StudyTab settings={DEFAULT_USER_SETTINGS} />);

    // SessionSetupForm's real submit button copy (Task 5, already committed) is "Start session" -
    // the Figma design (nodeId 58:450, confirmed via get_design_context) shows "Start Study
    // Session", but changing SessionSetupForm's button text is out of this task's scope (composing
    // existing components only), so this test targets what's actually rendered rather than the
    // design-intent copy. Flagged in the task report as a known follow-up.
    expect(screen.getByRole("button", { name: /^start session$/i })).toBeInTheDocument();
    // getByText(/task vault/i) is ambiguous here: it also matches the Goal select's
    // "Choose a task from the Task Vault" placeholder option. The heading is the actual
    // Task Vault card title (TaskVaultPage.tsx renders it as an <h2>).
    expect(screen.getByRole("heading", { name: /task vault/i })).toBeInTheDocument();

    await waitFor(() => expect(messenger.sendMessage).toHaveBeenCalledWith({ type: "TASK_LIST" }));
  });

  it("prefills Goal when a breakdown item is chosen from Task Vault", async () => {
    // Realistic breakdown item, matching TaskVaultPage.tsx's actual Task/TaskBreakdownItem shape.
    const task: Task = {
      id: "task_1",
      title: "STAT231",
      createdAt: 1,
      breakdown: [{ id: "item_1", description: "Chapter 6 of STAT231" }],
    };
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [task] });

    render(<StudyTab settings={DEFAULT_USER_SETTINGS} />);

    // TaskVaultPage (app/routes/TaskVaultPage.tsx) renders a "Start a session from this" button
    // per incomplete breakdown item, which calls onStartSessionFromBreakdownItem({ goal:
    // item.description, taskBreakdownItemId: item.id }) - StudyTab wires that into
    // SessionSetupForm's initialGoal/taskBreakdownItemId props.
    const startFromBreakdownButton = await screen.findByRole("button", {
      name: /start a session from this/i,
    });
    fireEvent.click(startFromBreakdownButton);

    await waitFor(() =>
      expect(screen.getByLabelText(/goal/i)).toHaveValue("Chapter 6 of STAT231")
    );
  });

  it("makes a task created in the Task Vault card immediately selectable in the Goal select above it (Fix 1 regression guard)", async () => {
    // Reproduces the exact final-review bug: a first-time user with no tasks yet creates their
    // first task in TaskVaultPage, right below SessionSetupForm in the same StudyTab. Before Fix
    // 1, SessionSetupForm's Goal select only fetched TASK_LIST once on its own mount and never saw
    // this later creation, so the new task was never selectable and submitting failed validation
    // ("Goal cannot be empty.").
    const newTask = { id: "task_new", title: "New task", createdAt: 2, breakdown: [] };
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "TASK_CREATE") return { ok: true, task: newTask };
      return { ok: true };
    });

    render(<StudyTab settings={DEFAULT_USER_SETTINGS} />);

    // Confirms the Goal select starts out with nothing to pick beyond the disabled placeholder -
    // the interesting assertion is what happens after creation, not before.
    await waitFor(() => expect(screen.getByText("No tasks yet.")).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: "New task" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("STAT231"), { target: { value: "New task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    // The newly created task is immediately an option in SessionSetupForm's Goal select, in the
    // same mounted StudyTab - no remount, no second fetch needed.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "New task" })).toBeInTheDocument()
    );

    // And it's actually selectable, not just rendered inert.
    fireEvent.change(screen.getByLabelText(/goal/i), { target: { value: "New task" } });
    expect(screen.getByLabelText(/goal/i)).toHaveValue("New task");
  });
});
