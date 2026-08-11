import { describe, it, expect } from "vitest";
import { getAnimationAsset, ANIMATION_REGISTRY } from "./animationRegistry";

describe("animationRegistry", () => {
  it("returns the exact asset for a known mode/wellnessState pair", () => {
    const asset = getAnimationAsset("study", "angry");
    expect(asset.id).toBe("study-angry");
  });

  it("falls back to study/focused for an unregistered pair", () => {
    const asset = getAnimationAsset("play", "sleepy");
    expect(asset.id).toBe("study-focused");
  });

  it("gives every registered asset a non-empty staticFrame", () => {
    for (const asset of Object.values(ANIMATION_REGISTRY)) {
      expect(asset.staticFrame.length).toBeGreaterThan(0);
    }
  });
});
