export interface HardBlockCredential {
  passcodeHash: string;
  passcodeSalt: string;
  failedAttempts: number;
  lockedUntil?: number;
}

const MAX_ATTEMPTS_BEFORE_LOCKOUT = 3;
const LOCKOUT_DURATION_MS = 60_000;
const PBKDF2_ITERATIONS = 100_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toHex(bytes.buffer);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

async function hashPasscode(passcode: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const passcodeBytes = encoder.encode(passcode);
  const saltBytes = hexToBytes(salt);

  const key = await crypto.subtle.importKey(
    "raw",
    passcodeBytes,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256
  );

  return toHex(derivedBits);
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
