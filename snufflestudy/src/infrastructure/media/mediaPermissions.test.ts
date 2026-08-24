import { describe, it, expect } from "vitest";
import { isMediaPermissionError } from "./mediaPermissions";

describe("isMediaPermissionError", () => {
  it("is true for a NotAllowedError DOMException (explicit block or a silently dismissed prompt)", () => {
    expect(isMediaPermissionError(new DOMException("Permission dismissed", "NotAllowedError"))).toBe(true);
  });

  it("is false for a NotFoundError (no camera/mic device present)", () => {
    expect(isMediaPermissionError(new DOMException("Requested device not found", "NotFoundError"))).toBe(
      false
    );
  });

  it("is false for a plain Error", () => {
    expect(isMediaPermissionError(new Error("network down"))).toBe(false);
  });

  it("is false for a non-error value", () => {
    expect(isMediaPermissionError("not an error")).toBe(false);
    expect(isMediaPermissionError(null)).toBe(false);
  });
});
