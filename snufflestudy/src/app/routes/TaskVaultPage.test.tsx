import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskVaultPage } from "./TaskVaultPage";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import type { Task } from "../../domain/tasks/taskTypes";

beforeEach(() => {
  vi.restoreAllMocks();
});

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    userId: null,
    title: "STAT231",
    createdAt: 1000,
    ...overrides,
  };
}

describe("TaskVaultPage", () => {
  it("loads tasks on mount via TASK_LIST and renders them", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      tasks: [buildTask()],
    });

    render(<TaskVaultPage onClose={vi.fn()} />);

    expect(await screen.findByText("STAT231")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({ type: "TASK_LIST" });
  });

  it("shows a message when there are no tasks yet", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [] });

    render(<TaskVaultPage onClose={vi.fn()} />);

    expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
  });

  it("surfaces an error instead of hanging when TASK_LIST fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<TaskVaultPage onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("creates a new task via TASK_CREATE and adds it to the visible list", async () => {
    const newTask = buildTask({ id: "task_2", title: "New task" });
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "TASK_CREATE") return { ok: true, task: newTask };
      throw new Error(`unexpected message ${message.type}`);
    });

    render(<TaskVaultPage onClose={vi.fn()} />);
    await screen.findByText("No tasks yet.");

    fireEvent.change(screen.getByPlaceholderText("STAT231"), { target: { value: "New task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByText("New task")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "TASK_CREATE",
      payload: { title: "New task" },
    });
  });

  it("deletes a task via TASK_DELETE and removes it from the list", async () => {
    const task = buildTask();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [task] };
      if (message.type === "TASK_DELETE") return { ok: true };
      throw new Error(`unexpected message ${message.type}`);
    });

    render(<TaskVaultPage onClose={vi.fn()} />);
    await screen.findByText("STAT231");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("STAT231")).not.toBeInTheDocument());
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "TASK_DELETE",
      payload: { taskId: "task_1" },
    });
  });

  it("calls onClose when Back is clicked", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [] });
    const onClose = vi.fn();

    render(<TaskVaultPage onClose={onClose} />);
    await screen.findByText("No tasks yet.");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalled();
  });

  // v3.4 Task 4: onClose is now optional - StudyTab.tsx (the only production mount point) no
  // longer passes one at all, so the Back button must not render there. Verified directly rather
  // than inferred from reading the source.
  it("does not render a Back button when onClose is omitted", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [] });

    render(<TaskVaultPage />);
    await screen.findByText("No tasks yet.");

    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });
});
