import { describe, it, expect, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { sendMessage, onMessage } from "./extensionMessenger";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("extensionMessenger", () => {
  it("delivers a message from sendMessage to a registered handler and returns its response", async () => {
    onMessage(async (message) => {
      if (message.type === "SESSION_GET_ACTIVE") {
        return { ok: true, session: null };
      }
      return { ok: false };
    });

    const response = await sendMessage<{ ok: boolean; session: null }>({ type: "SESSION_GET_ACTIVE" });
    expect(response).toEqual({ ok: true, session: null });
  });
});
