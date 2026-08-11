// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createHardBlockCredential, verifyPasscode } from "./hardBlockCredential";

describe("hardBlockCredential", () => {
  it("verifies the correct passcode", async () => {
    const credential = await createHardBlockCredential("1234");
    const result = await verifyPasscode(credential, "1234", 0);
    expect(result.success).toBe(true);
    expect(result.credential.failedAttempts).toBe(0);
  });

  it("rejects an incorrect passcode and increments failedAttempts", async () => {
    const credential = await createHardBlockCredential("1234");
    const result = await verifyPasscode(credential, "0000", 0);
    expect(result.success).toBe(false);
    expect(result.credential.failedAttempts).toBe(1);
  });

  it("never stores the passcode in plaintext", async () => {
    const credential = await createHardBlockCredential("1234");
    expect(credential.passcodeHash).not.toContain("1234");
    expect(JSON.stringify(credential)).not.toContain("1234");
  });

  it("locks out after 3 failed attempts", async () => {
    let credential = await createHardBlockCredential("1234");
    for (let i = 0; i < 3; i++) {
      const result = await verifyPasscode(credential, "0000", i * 1000);
      credential = result.credential;
    }
    expect(credential.lockedUntil).toBeDefined();

    const duringLockout = await verifyPasscode(credential, "1234", credential.lockedUntil! - 1);
    expect(duringLockout.success).toBe(false);

    const afterLockout = await verifyPasscode(credential, "1234", credential.lockedUntil! + 1);
    expect(afterLockout.success).toBe(true);
  });

  it("resets failedAttempts after a successful verification", async () => {
    let credential = await createHardBlockCredential("1234");
    const failed = await verifyPasscode(credential, "0000", 0);
    credential = failed.credential;
    expect(credential.failedAttempts).toBe(1);

    const succeeded = await verifyPasscode(credential, "1234", 1000);
    expect(succeeded.credential.failedAttempts).toBe(0);
    expect(succeeded.credential.lockedUntil).toBeUndefined();
  });
});
