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

  it("renders a checkbox instead of a Delete button, unchecked for an uncompleted task", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [buildTask()] });

    render(<TaskVaultPage onClose={vi.fn()} />);
    await screen.findByText("STAT231");

    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("marks a task done via TASK_UPDATE when its checkbox is checked", async () => {
    const task = buildTask();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [task] };
      if (message.type === "TASK_UPDATE") return { ok: true, task: message.payload };
      throw new Error(`unexpected message ${message.type}`);
    });

    render(<TaskVaultPage onClose={vi.fn()} />);
    await screen.findByText("STAT231");

    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "TASK_UPDATE",
      payload: expect.objectContaining({ id: "task_1", completedAt: expect.any(Number) }),
    });
  });

  it("rolls back the checkbox when TASK_UPDATE fails", async () => {
    const task = buildTask();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [task] };
      if (message.type === "TASK_UPDATE") return { ok: false, error: "Could not update task." };
      throw new Error(`unexpected message ${message.type}`);
    });

    render(<TaskVaultPage onClose={vi.fn()} />);
    await screen.findByText("STAT231");

    fireEvent.click(screen.getByRole("checkbox"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not update task.");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("sorts completed tasks below uncompleted ones", async () => {
    const done = buildTask({ id: "task_done", title: "Done task", completedAt: 500 });
    const notDone = buildTask({ id: "task_not_done", title: "Not done task" });
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [done, notDone] });

    render(<TaskVaultPage onClose={vi.fn()} />);
    await screen.findByText("Done task");

    const titles = screen
      .getAllByText(/task$/, { selector: ".task-vault-page__task-title" })
      .map((el) => el.textContent);
    expect(titles).toEqual(["Not done task", "Done task"]);
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
