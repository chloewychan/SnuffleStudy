import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionSetupForm } from "./SessionSetupForm";
import * as messenger from "../../infrastructure/messaging/extensionMessenger";
import * as permissionsApi from "../../infrastructure/browser/permissionsApi";
import { DEFAULT_USER_SETTINGS } from "../../domain/settings/userSettings";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SessionSetupForm", () => {
  it("creates and starts a session on submit", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") {
        return { ok: true, tasks: [{ id: "t1", title: "Read chapter 3", createdAt: 1 }] };
      }
      if (message.type === "SESSION_CREATE") return { ok: true, session: { id: "session_1" } };
      return { ok: true };
    });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);
    expect(screen.getByLabelText(/goal/i)).toHaveValue("");

    fireEvent.change(await screen.findByLabelText(/goal/i), {
      target: { value: "Read chapter 3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Study Session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SESSION_CREATE",
          payload: expect.objectContaining({ goal: "Read chapter 3" }),
        })
      )
    );
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "SESSION_START",
      payload: { sessionId: "session_1" },
    });
  });

  it("shows validation errors instead of starting a session", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "SESSION_CREATE") return { ok: false, errors: ["Goal cannot be empty"] };
      return { ok: true };
    });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);
    fireEvent.click(screen.getByRole("button", { name: "Start Study Session" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Goal cannot be empty"));
  });

  it("surfaces an error and does not crash when sendMessage rejects", async () => {
    // sendMessage (chrome.runtime.sendMessage) can reject — e.g. "Could not establish
    // connection. Receiving end does not exist." during service-worker startup races,
    // or extension-context-invalidated. The submit handler must catch it instead of
    // throwing from the form's onSubmit handler and leaving the button doing nothing.
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "SESSION_CREATE") {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return { ok: true };
    });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);
    fireEvent.click(screen.getByRole("button", { name: "Start Study Session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "SESSION_CREATE" }))
    );

    // (a) no unhandled rejection surfaces / component doesn't crash — implied by these
    // assertions succeeding, since vitest fails the test on unhandled rejections.
    // (b) an error indication is visible to the user via the existing alert mechanism.
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not establish connection/);

    // (c) the button is still present and usable — the form survived the rejection.
    expect(screen.getByRole("button", { name: "Start Study Session" })).toBeInTheDocument();
  });

  it("requests hard-block host permission before creating a hard-mode session, and proceeds when granted", async () => {
    const permissionSpy = vi
      .spyOn(permissionsApi, "requestHardBlockHostPermission")
      .mockResolvedValue(true);
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "SESSION_CREATE") return { ok: true, session: { id: "session_1" } };
      return { ok: true };
    });

    const settings = {
      ...DEFAULT_USER_SETTINGS,
      defaultRestrictionMode: "hard" as const,
      defaultRestrictedSites: ["youtube.com", "reddit.com"],
    };
    render(<SessionSetupForm settings={settings} />);

    fireEvent.click(screen.getByRole("button", { name: "Start Study Session" }));

    await waitFor(() => expect(permissionSpy).toHaveBeenCalledWith(["youtube.com", "reddit.com"]));
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SESSION_CREATE" })
      )
    );
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "SESSION_START",
      payload: { sessionId: "session_1" },
    });
  });

  it("surfaces an error and does not create a session when hard-block host permission is denied", async () => {
    vi.spyOn(permissionsApi, "requestHardBlockHostPermission").mockResolvedValue(false);
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true, tasks: [] });

    const settings = {
      ...DEFAULT_USER_SETTINGS,
      defaultRestrictionMode: "hard" as const,
      defaultRestrictedSites: ["youtube.com"],
    };
    render(<SessionSetupForm settings={settings} />);

    fireEvent.click(screen.getByRole("button", { name: "Start Study Session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Hard-mode blocking needs permission/
    );
    // The mount-time TASK_LIST fetch still happens (it's independent of the submit flow);
    // what matters is that permission denial stops the submit flow before SESSION_CREATE.
    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_CREATE" })
    );
  });

  it("does not request hard-block host permission in soft mode, even with sites configured", async () => {
    const permissionSpy = vi.spyOn(permissionsApi, "requestHardBlockHostPermission");
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "SESSION_CREATE") return { ok: true, session: { id: "session_1" } };
      return { ok: true };
    });

    const settings = {
      ...DEFAULT_USER_SETTINGS,
      defaultRestrictionMode: "soft" as const,
      defaultRestrictedSites: ["youtube.com"],
    };
    render(<SessionSetupForm settings={settings} />);

    fireEvent.click(screen.getByRole("button", { name: "Start Study Session" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Start Study Session" })).toBeEnabled());
    expect(permissionSpy).not.toHaveBeenCalled();
  });

  it("does not request hard-block host permission in hard mode when no restricted sites are configured", async () => {
    const permissionSpy = vi.spyOn(permissionsApi, "requestHardBlockHostPermission");
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "SESSION_CREATE") return { ok: true, session: { id: "session_1" } };
      return { ok: true };
    });

    const settings = {
      ...DEFAULT_USER_SETTINGS,
      defaultRestrictionMode: "hard" as const,
      defaultRestrictedSites: [] as string[],
    };
    render(<SessionSetupForm settings={settings} />);

    fireEvent.click(screen.getByRole("button", { name: "Start Study Session" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Start Study Session" })).toBeEnabled());
    expect(permissionSpy).not.toHaveBeenCalled();
  });

  it("populates the Goal select from Task Vault", async () => {
    vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") {
        return {
          ok: true,
          tasks: [
            { id: "t1", title: "Finish essay", createdAt: 1 },
            { id: "t2", title: "Read chapter 4", createdAt: 2 },
          ],
        };
      }
      return { ok: true };
    });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);

    expect(await screen.findByRole("option", { name: "Finish essay" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Read chapter 4" })).toBeInTheDocument();
  });

  it("uses the tasks prop instead of fetching its own TASK_LIST copy when the parent already owns a list (Fix 1)", async () => {
    // StudyTab.tsx now owns the task list (fed by TaskVaultPage's onTasksChanged) and passes it
    // down here as a prop - this component must render from that prop, not issue its own
    // redundant TASK_LIST fetch, so a task created elsewhere shows up without a second round trip.
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockResolvedValue({ ok: true });

    render(
      <SessionSetupForm
        settings={DEFAULT_USER_SETTINGS}
        tasks={[{ id: "t1", userId: null, title: "From parent", createdAt: 1 }]}
      />
    );

    expect(await screen.findByRole("option", { name: "From parent" })).toBeInTheDocument();
    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "TASK_LIST" })
    );
  });

  it("accepts hours and minutes for focus duration and sums them to seconds on submit", async () => {
    const sendMessageSpy = vi.spyOn(messenger, "sendMessage").mockImplementation(async (message: any) => {
      if (message.type === "TASK_LIST") return { ok: true, tasks: [] };
      if (message.type === "SESSION_CREATE") return { ok: true, session: { id: "session_1" } };
      return { ok: true };
    });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);

    fireEvent.change(screen.getByLabelText(/hours/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/minutes/i), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Study Session" }));

    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SESSION_CREATE",
          payload: expect.objectContaining({ focusDurationSeconds: 5400 }),
        })
      )
    );
  });

  it("clamps out-of-range hours/minutes instead of letting them silently block submission", async () => {
    // A number input with an out-of-range value fails the browser's native constraint
    // validation (form.checkValidity() === false), which silently blocks the submit event
    // entirely - handleSubmit never runs and no error is shown, unlike every other invalid
    // state in this form (which surfaces via the `error`/alert mechanism). Clamping in
    // onChange keeps state from ever holding an out-of-range value, so this can't happen.
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, tasks: [] });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);
    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledWith({ type: "TASK_LIST" }));

    const hours = screen.getByLabelText(/hours/i) as HTMLInputElement;
    const minutes = screen.getByLabelText(/minutes/i) as HTMLInputElement;

    fireEvent.change(hours, { target: { value: "4" } });
    expect(hours).toHaveValue(3);

    fireEvent.change(minutes, { target: { value: "90" } });
    expect(minutes).toHaveValue(59);

    fireEvent.change(hours, { target: { value: "-1" } });
    expect(hours).toHaveValue(0);
  });

  it("renders Restriction Mode as a select with soft/hard options", async () => {
    const sendMessageSpy = vi
      .spyOn(messenger, "sendMessage")
      .mockResolvedValue({ ok: true, tasks: [] });

    render(<SessionSetupForm settings={DEFAULT_USER_SETTINGS} />);
    await waitFor(() => expect(sendMessageSpy).toHaveBeenCalledWith({ type: "TASK_LIST" }));

    const select = screen.getByLabelText(/restriction mode/i) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: /soft/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /hard/i })).toBeInTheDocument();
  });
});
