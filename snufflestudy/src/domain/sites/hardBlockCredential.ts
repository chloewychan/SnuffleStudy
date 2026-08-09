export interface HardBlockCredential {
  passcodeHash: string;
  passcodeSalt: string;
  failedAttempts: number;
  lockedUntil?: number;
}

const MAX_ATTEMPTS_BEFORE_LOCKOUT = 3;
const LOCKOUT_DURATION_MS = 60_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toHex(bytes.buffer);
}

async function hashPasscode(passcode: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${salt}:${passcode}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

export async function createHardBlockCredential(passcode: string): Promise<HardBlockCredential> {
  const passcodeSalt = randomSalt();
  const passcodeHash = await hashPasscode(passcode, passcodeSalt);
  return { passcodeHash, passcodeSalt, failedAttempts: 0 };
}

export async function verifyPasscode(
  credential: HardBlockCredential,
  passcode: string,
  now: number
): Promise<{ credential: HardBlockCredential; success: boolean }> {
  if (credential.lockedUntil && now < credential.lockedUntil) {
    return { credential, success: false };
  }

  const candidateHash = await hashPasscode(passcode, credential.passcodeSalt);
  if (candidateHash === credential.passcodeHash) {
    return {
      credential: { ...credential, failedAttempts: 0, lockedUntil: undefined },
      success: true,
    };
  }

  const failedAttempts = credential.failedAttempts + 1;
  const lockedUntil =
    failedAttempts >= MAX_ATTEMPTS_BEFORE_LOCKOUT ? now + LOCKOUT_DURATION_MS : undefined;

  return { credential: { ...credential, failedAttempts, lockedUntil }, success: false };
}
