import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StudyTab } from "./StudyTab";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";
import { StudyRoomSessionProvider } from "../studyRoom/StudyRoomSessionContext";
import { RefreshRegistryProvider } from "../refresh/RefreshRegistryContext";

// v4.1 Task 7: StudyTab now also mounts StudyRoomsBox (a third sp-card), which reads from
// useStudyRoomSession() - every render here needs the same two app-shell providers
// SidePanelApp.tsx wraps its whole tree in.
function renderStudyTab() {
  return render(
    <RefreshRegistryProvider>
      <StudyRoomSessionProvider>
        <StudyTab settings={DEFAULT_USER_SETTINGS} />
      </StudyRoomSessionProvider>
    </RefreshRegistryProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("StudyTab", () => {
  it("renders both the session setup form and the task vault", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [] });

    renderStudyTab();

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

    // v3.4 Task 4: TaskVaultPage's onClose is now optional (rendered only when a real handler is
    // passed), and this component no longer passes a no-op - this used to be a routed page with
    // somewhere real to go back to, now permanently embedded here with nowhere to go.
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();

    await waitFor(() => expect(messenger.sendMessage).toHaveBeenCalledWith({ type: "TASK_LIST" }));
  });

  // v4.1 Task 7: StudyRoomsBox moved in from the Friends tab, mounted as a third sp-card
  // (SessionSetupForm, TaskVaultPage, StudyRoomsBox).
  it("mounts StudyRoomsBox as a third sp-card, alongside SessionSetupForm/TaskVaultPage", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      tasks: [],
      rooms: [],
      session: { user: { id: "user-self" } },
    });

    renderStudyTab();

    expect(await screen.findByRole("heading", { name: "Study Rooms" })).toBeInTheDocument();
    expect(document.querySelectorAll(".sp-study-tab > section.sp-card").length).toBe(3);
    await waitFor(() => expect(messenger.sendMessage).toHaveBeenCalledWith({ type: "STUDY_ROOM_LIST" }));
  });

  it("makes a task created in the Task Vault card immediately selectable in the Goal select above it (Fix 1 regression guard)", async () => {
    // Reproduces the exact final-review bug: a first-time user with no tasks yet creates their
    // first task in TaskVaultPage, right below SessionSetupForm in the same StudyTab. Before Fix
    // 1, SessionSetupForm's Goal select only fetched TASK_LIST once on its own mount and never saw
    // this later creation, so the new task was never selectable and submitting failed validation
    // ("Goal cannot be empty.").
    const newTask = { id: "task_new", title: "New task", createdAt: 2 };
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "TASK_CREATE") return { ok: true, task: newTask };
      return { ok: true };
    });

    renderStudyTab();

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
