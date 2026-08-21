import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startIdleMonitoring, stopIdleMonitoring } from "./idleApi";
import { stubFakeIdle } from "../../background/testSupport/fakeIdle";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("idleApi", () => {
  it("sets the detection interval and forwards state changes to the callback", () => {
    const fakeIdle = stubFakeIdle();
    const onStateChange = vi.fn();

    startIdleMonitoring(15, onStateChange);

    expect(fakeIdle.setDetectionInterval).toHaveBeenCalledWith(15);
    fakeIdle.__emit("idle");

    expect(onStateChange).toHaveBeenCalledWith("idle");
  });

  it("stops forwarding state changes once stopped", () => {
    const fakeIdle = stubFakeIdle();
    const onStateChange = vi.fn();

    startIdleMonitoring(15, onStateChange);
    stopIdleMonitoring();
    fakeIdle.__emit("active");

    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("is safe to call stopIdleMonitoring when nothing is monitoring", () => {
    stubFakeIdle();
    expect(() => stopIdleMonitoring()).not.toThrow();
  });

  it("replaces the previous listener rather than stacking a second one when started twice", () => {
    const fakeIdle = stubFakeIdle();
    const first = vi.fn();
    const second = vi.fn();

    startIdleMonitoring(15, first);
    startIdleMonitoring(30, second);
    fakeIdle.__emit("locked");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("locked");
  });
});
