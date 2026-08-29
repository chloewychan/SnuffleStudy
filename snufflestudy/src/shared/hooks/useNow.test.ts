import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNow } from "./useNow";

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates on every interval tick while mounted", () => {
    const { result } = renderHook(() => useNow(1000));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBeGreaterThan(first);

    const second = result.current;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBeGreaterThan(second);
  });

  it("clears its interval on unmount instead of continuing to tick", () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const { unmount } = renderHook(() => useNow(1000));

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
