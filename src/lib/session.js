// Database-backed sessions in an HttpOnly cookie. The raw token is never stored, only its SHA-256.
// Revoking rows (password reset) ends every existing login for that account immediately.
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { one, run, nowIso } from "./db.js";

export const SESSION_COOKIE = "sb_session";
const SESSION_DAYS = 7;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isSecureRequest(c) {
  return new URL(c.req.url).protocol === "https:";
}

export async function createSession(c, accountId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await run(
    c.env.DB,
    "INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    await sha256Hex(token), accountId, nowIso(), expires.toISOString(),
  );
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Strict",
    path: "/",
    expires,
  });
}

export async function resolveSession(c) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return one(
    c.env.DB,
    `SELECT a.id, a.name, a.login, a.is_admin, s.token_hash
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    await sha256Hex(token), nowIso(),
  );
}

export async function destroySession(c) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", nowIso(), await sha256Hex(token));
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export { sha256Hex };
