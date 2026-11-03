import { resolveSession } from "./session.js";

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const requireAuth = async (c, next) => {
  const account = await resolveSession(c);
  if (!account) return c.json({ error: "Please sign in.", code: "UNAUTHENTICATED" }, 401);
  c.set("account", account);
  return next();
};

// Admin routes answer 404 to non-admins so their existence is not revealed.
export const requireAdmin = async (c, next) => {
  const account = c.get("account");
  if (!account?.is_admin) return c.json({ error: "Not found." }, 404);
  return next();
};

export async function readJson(c) {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new HttpError(400, "Request body must be JSON.", "BAD_JSON");
  }
}

export function accountId(c) {
  return c.get("account").id;
}

export function str(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

export function intEnv(env, key, fallback) {
  const n = Number.parseInt(env?.[key], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
