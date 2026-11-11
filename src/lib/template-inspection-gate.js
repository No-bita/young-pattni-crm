// Reversible, non-secret diagnostic gate. Missing/invalid configuration means OFF.
// Cooldown/in-flight control is BEST EFFORT per Worker isolate, not a global quota.
const MAX_WINDOW_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
let limiter = { key: "", busy: false, nextAt: 0 };
const utc = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) && Number.isFinite(Date.parse(s));
const id = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v);

export function inspectionGate(env, accountId, now = Date.now()) {
  const account = env.TEMPLATE_INSPECTION_ACCOUNT_ID;
  const template = env.TEMPLATE_INSPECTION_TEMPLATE_ID;
  const from = env.TEMPLATE_INSPECTION_FROM;
  const until = env.TEMPLATE_INSPECTION_UNTIL;
  if (!id(account) || !id(template) || account !== accountId || !utc(from) || !utc(until)) return null;
  const start = Date.parse(from), end = Date.parse(until);
  if (end <= start || end - start > MAX_WINDOW_MS || now < start || now >= end) return null;
  return { templateId: template, expiresAt: until, key: `${account}:${template}:${from}:${until}` };
}

export function claimInspection(gate, now = Date.now()) {
  if (limiter.key !== gate.key) limiter = { key: gate.key, busy: false, nextAt: 0 };
  if (limiter.busy || now < limiter.nextAt) return null;
  const claimed = limiter;
  claimed.busy = true;
  claimed.nextAt = now + COOLDOWN_MS;
  return () => { claimed.busy = false; };
}
