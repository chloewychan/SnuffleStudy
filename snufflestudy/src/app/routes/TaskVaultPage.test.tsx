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
    title: "STAT231",
    createdAt: 1000,
    breakdown: [],
    ...overrides,
  };
}

describe("TaskVaultPage", () => {
  it("loads tasks on mount via TASK_LIST and renders them with their breakdown items", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({
      ok: true,
      tasks: [buildTask({ breakdown: [{ id: "item_1", description: "Chapter 6 of STAT231" }] })],
    });

    render(<TaskVaultPage onClose={vi.fn()} onStartSessionFromBreakdownItem={vi.fn()} />);

    expect(await screen.findByText("STAT231")).toBeInTheDocument();
    expect(screen.getByText("Chapter 6 of STAT231")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({ type: "TASK_LIST" });
  });

  it("shows a message when there are no tasks yet", async () => {
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [] });

    render(<TaskVaultPage onClose={vi.fn()} onStartSessionFromBreakdownItem={vi.fn()} />);

    expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
  });

  it("surfaces an error instead of hanging when TASK_LIST fails", async () => {
    vi.spyOn(messenger, "sendMessage").mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<TaskVaultPage onClose={vi.fn()} onStartSessionFromBreakdownItem={vi.fn()} />);

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

    render(<TaskVaultPage onClose={vi.fn()} onStartSessionFromBreakdownItem={vi.fn()} />);
    await screen.findByText("No tasks yet.");

    fireEvent.change(screen.getByPlaceholderText("STAT231"), { target: { value: "New task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByText("New task")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "TASK_CREATE",
      payload: { title: "New task" },
    });
  });

  it("adds a breakdown item to a task via TASK_ADD_BREAKDOWN_ITEM", async () => {
    const task = buildTask();
    const updatedTask = {
      ...task,
      breakdown: [{ id: "item_1", description: "Chapter 6 of STAT231" }],
    };
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [task] };
      if (message.type === "TASK_ADD_BREAKDOWN_ITEM") return { ok: true, task: updatedTask };
      throw new Error(`unexpected message ${message.type}`);
    });

    render(<TaskVaultPage onClose={vi.fn()} onStartSessionFromBreakdownItem={vi.fn()} />);
    await screen.findByText("STAT231");

    fireEvent.change(screen.getByLabelText("Add breakdown item for STAT231"), {
      target: { value: "Chapter 6 of STAT231" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add breakdown item" }));

    expect(await screen.findByText("Chapter 6 of STAT231")).toBeInTheDocument();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      type: "TASK_ADD_BREAKDOWN_ITEM",
      payload: { taskId: "task_1", description: "Chapter 6 of STAT231" },
    });
  });

  it('invokes onStartSessionFromBreakdownItem with the item description as goal when "Start a session from this" is clicked', async () => {
    const task = buildTask({
      breakdown: [{ id: "item_1", description: "Chapter 6 of STAT231" }],
    });
    vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [task] });
    const onStart = vi.fn();

    render(<TaskVaultPage onClose={vi.fn()} onStartSessionFromBreakdownItem={onStart} />);
    await screen.findByText("Chapter 6 of STAT231");

    fireEvent.click(screen.getByRole("button", { name: "Start a session from this" }));

    expect(onStart).toHaveBeenCalledWith({
      goal: "Chapter 6 of STAT231",
      taskBreakdownItemId: "item_1",
    });
  });

  it("toggles a breakdown item's completion via TASK_UPDATE and hides the start-session action once completed", async () => {
    const task = buildTask({
      breakdown: [{ id: "item_1", description: "Chapter 6 of STAT231" }],
    });
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(
      async (message: any) => {
        if (message.type === "TASK_LIST") return { ok: true, tasks: [task] };
        if (message.type === "TASK_UPDATE") return { ok: true, task: message.payload };
        throw new Error(`unexpected message ${message.type}`);
      }
    );

    render(<TaskVaultPage onClose={vi.fn()} onStartSessionFromBreakdownItem={vi.fn()} />);
    await screen.findByText("Chapter 6 of STAT231");

    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "TASK_UPDATE",
          payload: expect.objectContaining({
            breakdown: [expect.objectContaining({ id: "item_1", completedAt: expect.any(Number) })],
          }),
        })
      )
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Start a session from this" })
      ).not.toBeInTheDocument()
    );
  });

  it("rolls back the checkbox state when TASK_UPDATE fails", async () => {
    const task = buildTask({
      breakdown: [{ id: "item_1", description: "Chapter 6 of STAT231" }],
    });
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [task] };
      if (message.type === "TASK_UPDATE") return { ok: false, error: "boom" };
      throw new Error(`unexpected message ${message.type}`);
    });

    render(<TaskVaultPage onClose={vi.fn()} onStartSessionFromBreakdownItem={vi.fn()} />);
    await screen.findByText("Chapter 6 of STAT231");

    fireEvent.click(screen.getByRole("checkbox"));

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
  });

  it("deletes a task via TASK_DELETE and removes it from the list", async () => {
    const task = buildTask();
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [task] };
      if (message.type === "TASK_DELETE") return { ok: true };
      throw new Error(`unexpected message ${message.type}`);
    });

    render(<TaskVaultPage onClose={vi.fn()} onStartSessionFromBreakdownItem={vi.fn()} />);
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

    render(<TaskVaultPage onClose={onClose} onStartSessionFromBreakdownItem={vi.fn()} />);
    await screen.findByText("No tasks yet.");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalled();
  });
});
