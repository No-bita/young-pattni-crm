export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Could not reach PJM Youth CRM. Check your connection and try again.", 0, null);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 && path !== "/auth/login") {
    window.dispatchEvent(new Event("sb:signed-out"));
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status, data);
  return data;
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const STATUS = {
  sent: ["Sent", ""], delivered: ["Delivered", "ok"], read: ["Read", "ok"], failed: ["Failed", "bad"],
  sending: ["Sending", "warn"], queued: ["Queued", "neutral"], pending: ["Pending", "neutral"], received: ["Received", "neutral"],
  skipped_suppressed: ["Skipped: opted out", "neutral"], cancelled: ["Cancelled", "neutral"],
  draft: ["Draft", "neutral"], scheduled: ["Scheduled", "warn"], completed: ["Completed", "ok"],
  active: ["Active", "ok"], inactive: ["Inactive", "neutral"], retired: ["Retired", "neutral"],
};

export function statusPill(status) {
  const [label, cls] = STATUS[status] || [status, "neutral"];
  return { label, cls };
}

export function go(path) {
  window.location.hash = path;
}

// Multipart upload of one file to an authenticated endpoint. Never sends tokens; the session cookie is enough.
export async function apiUpload(path, file) {
  const form = new FormData();
  form.append("file", file, file.name);
  let res;
  try {
    res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", body: form });
  } catch {
    throw new ApiError("Could not reach the CRM. Check your connection and try again.", 0, null);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) window.dispatchEvent(new Event("sb:signed-out"));
  if (!res.ok) throw new ApiError(data?.error || `Upload failed (${res.status}).`, res.status, data);
  return data;
}

export function fmtBytes(n) {
  if (n == null) return "";
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
         }
