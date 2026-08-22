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
});
