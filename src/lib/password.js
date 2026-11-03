// PBKDF2-SHA256 password hashing via Web Crypto. Runs unchanged in the Worker and in Node 22
// (the local admin script imports this same file, so created accounts always verify at login).
// Format and parameters are carried over from the previous Springboard codebase.

const ITERATIONS = 100000;
const encoder = new TextEncoder();

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSaltHex(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function derive(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(saltHex), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(bits);
}

export async function hashPassword(password, saltHex = randomSaltHex()) {
  const hash = await derive(password, saltHex, ITERATIONS);
  return `pbkdf2:${ITERATIONS}:${saltHex}:${hash}`;
}

export function timingSafeEqualStr(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  if (!password || !stored || !stored.startsWith("pbkdf2:")) return false;
  const parts = stored.split(":");
  if (parts.length !== 4) return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const computed = await derive(password, parts[2], iterations);
  return timingSafeEqualStr(computed, parts[3]);
}

export const MIN_PASSWORD_LENGTH = 10;
