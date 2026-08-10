import { describe, it, expect, vi } from "vitest";
import { onUserActivity } from "./pageActivity";

describe("onUserActivity", () => {
  it("invokes the callback on mousemove", () => {
    const callback = vi.fn();
    onUserActivity(callback);

    window.dispatchEvent(new Event("mousemove"));

    expect(callback).toHaveBeenCalled();
  });

  it("returns a cleanup function that removes all listeners", () => {
    const callback = vi.fn();
    const cleanup = onUserActivity(callback);
    cleanup();

    window.dispatchEvent(new Event("keydown"));

    expect(callback).not.toHaveBeenCalled();
  });
});
