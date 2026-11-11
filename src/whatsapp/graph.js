import { readResponseLimited } from "../lib/body.js";
// Meta Graph API client. Every call is made for ONE sender, with that sender's own token.
// There is deliberately no fallback to any other phone number id or token.

export class GraphError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function tokenFor(env, sender) {
  const token = env[`WA_TOKEN_${sender.token_ref}`];
  if (!token) {
    throw new GraphError(`Token secret WA_TOKEN_${sender.token_ref} is not set in Cloudflare.`, { code: "TOKEN_MISSING" });
  }
  return token;
}

function base(env) {
  return `https://graph.facebook.com/${env.GRAPH_API_VERSION || "v23.0"}`;
}

async function call(env, sender, method, path, body, { timeoutMs = null } = {}) {
  const token = tokenFor(env, sender); // a missing secret is reported as such, not as a network error
  let res;
  try {
    res = await fetch(`${base(env)}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual", // Graph API calls are never redirected; a redirect is treated as an error below
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new GraphError("Meta's WhatsApp API did not answer in time.", { code: "TIMEOUT" });
    }
    // Network failure: Meta never confirmed the message, so it is reported as failed (not retried).
    throw new GraphError("Could not reach Meta's WhatsApp API. The message was not confirmed as sent.", { code: "NETWORK" });
  }
  if (res.status >= 300 && res.status < 400) {
    throw new GraphError("Meta's WhatsApp API answered with an unexpected redirect.", { status: res.status, code: "REDIRECT" });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data?.error || {};
    throw new GraphError(err.error_data?.details || err.message || `Meta API returned ${res.status}`, {
      status: res.status,
      code: err.code,
      details: err,
    });
  }
  return data;
}

export async function getPhoneNumber(env, sender) {
  return call(env, sender, "GET", `${encodeURIComponent(sender.phone_number_id)}?fields=display_phone_number,verified_name,quality_rating`);
}

export async function listWabaPhoneNumbers(env, sender) {
  return call(env, sender, "GET", `${encodeURIComponent(sender.waba_id)}/phone_numbers?fields=id,display_phone_number`);
}

export async function listTemplates(env, sender) {
  const out = [];
  let path = `${encodeURIComponent(sender.waba_id)}/message_templates?fields=id,name,language,status,category,components&limit=100`;
  for (let page = 0; page < 50 && path; page++) {
    const data = await call(env, sender, "GET", path);
    out.push(...(data?.data || []));
    const next = data?.paging?.next;
    path = next ? next.replace(`${base(env)}/`, "") : null;
  }
  return out;
}

// Looks up ONE template in the sender's Messaging account by exact name and language, using Meta's
// documented name/language filters. Pagination (rare for a filtered query) follows only the opaque
// "after" cursor, never a returned link.
export async function findTemplate(env, sender, { name, language }, { timeoutMs = null } = {}) {
  const q = new URLSearchParams({ name, language, fields: "id,name,language,status,category,components", limit: "25" });
  for (let page = 0; page < 5; page++) {
    const data = await call(env, sender, "GET", `${encodeURIComponent(sender.waba_id)}/message_templates?${q}`, undefined, { timeoutMs });
    const hit = (data?.data || []).find((t) => t?.name === name && t?.language === language);
    if (hit) return hit;
    const after = data?.paging?.cursors?.after;
    if (!after || !data?.paging?.next) return null;
    q.set("after", after);
  }
  return null;
}

export async function sendTemplate(env, sender, { to, name, language, bodyParams, headerImageId = null }) {
  const components = [];
  // HEADER media comes first; Meta requires matching media on every send of a media-header template.
  if (headerImageId) components.push({ type: "header", parameters: [{ type: "image", image: { id: String(headerImageId) } }] });
  if (bodyParams.length) components.push({ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text: String(text) })) });
  const data = await call(env, sender, "POST", `${encodeURIComponent(sender.phone_number_id)}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name, language: { code: language }, components },
  });
  return data?.messages?.[0]?.id || null;
}

// Uploads a file to Meta through ONE phone number. Returns Meta's media id (valid 30 days per Meta docs).
export async function uploadMedia(env, sender, { bytes, mimeType, filename }) {
  const token = tokenFor(env, sender);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([bytes], { type: mimeType }), filename || "upload");
  let res;
  try {
    res = await fetch(`${base(env)}/${encodeURIComponent(sender.phone_number_id)}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    throw new GraphError("Could not reach Meta's WhatsApp API. The image was not uploaded.", { code: "NETWORK" });
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data?.id) {
    const err = data?.error || {};
    throw new GraphError(err.error_data?.details || err.message || `Meta API returned ${res.status}`, { status: res.status, code: err.code });
  }
  return String(data.id);
}

// Fetches an uploaded file's bytes for an authenticated preview. Meta's download URL is temporary
// (5 minutes) and is used immediately, never stored or sent to the browser.
const META_MEDIA_HOST = /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/i;
// Fetches an uploaded file's bytes for an authenticated preview. Meta's download URL is temporary
// (5 minutes) and is used immediately, never stored or sent to the browser.
// Safeguards: the download host must be a Meta host; redirects are NOT followed (so the token is
// never sent anywhere else); one deadline covers both requests; at most maxBytes are read.
export async function fetchMediaBytes(env, sender, mediaId, { timeoutMs, maxBytes }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const info = await call(env, sender, "GET", `${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(sender.phone_number_id)}`, undefined, { timeoutMs });
  const url = info?.url ? new URL(info.url) : null;
  if (!url || url.protocol !== "https:" || !META_MEDIA_HOST.test(url.hostname)) {
    throw new GraphError("Meta returned an unexpected media location.", { code: "BAD_MEDIA_URL" });
  }
  let res;
  try {
    res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${tokenFor(env, sender)}` }, redirect: "manual", signal: deadline });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new GraphError("Meta did not return the image in time.", { code: "TIMEOUT" });
    throw new GraphError("Could not reach Meta to load the image.", { code: "NETWORK" });
  }
  if (res.status >= 300 && res.status < 400) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new GraphError("Meta redirected the image download; redirects are not followed.", { status: res.status, code: "REDIRECT" });
  }
  if (!res.ok) throw new GraphError(`Meta returned ${res.status} for the image.`, { status: res.status });
  let bytes;
  try {
    bytes = await readResponseLimited(res, maxBytes);
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new GraphError("Meta did not return the image in time.", { code: "TIMEOUT" });
    if (e?.code === "TOO_LARGE") throw new GraphError("The image from Meta is larger than allowed.", { code: "TOO_LARGE" });
    throw new GraphError("The image download from Meta was interrupted.", { code: "NETWORK" });
  }
  return { bytes, mimeType: info.mime_type || res.headers.get("Content-Type") || "application/octet-stream" };
}

export async function sendText(env, sender, { to, text }) {
  const data = await call(env, sender, "POST", `${encodeURIComponent(sender.phone_number_id)}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
  return data?.messages?.[0]?.id || null;
}

// Reads a template definition from Meta and decides whether this app can send it.
// Supported shape: optional TEXT header without variables, or an IMAGE header; a body with
// positional {{n}} text variables; optional footer; buttons that need no send-time values
// (QUICK_REPLY, PHONE_NUMBER, URL without a variable). Anything else gets a plain reason.
const VARS = /\{\{\s*([^}]*?)\s*\}\}/g;

function countVars(text) {
  const names = [...String(text || "").matchAll(VARS)].map((m) => m[1]);
  return { count: new Set(names).size, named: names.some((n) => !/^\d+$/.test(n)) };
}

const FORMAT_LABEL = { VIDEO: "Video", DOCUMENT: "Document", LOCATION: "Location", GIF: "GIF" };

export function describeTemplate(tpl) {
  const components = Array.isArray(tpl.components) ? tpl.components : [];
  const body = components.find((c) => String(c.type).toUpperCase() === "BODY");
  const header = components.find((c) => String(c.type).toUpperCase() === "HEADER");
  const buttonsComp = components.find((c) => String(c.type).toUpperCase() === "BUTTONS");
  const reasons = [];

  const headerFormat = header ? String(header.format || "TEXT").toUpperCase() : "NONE";
  let headerParamCount = 0;
  if (headerFormat === "TEXT") {
    headerParamCount = countVars(header.text).count;
    if (headerParamCount > 0) reasons.push("Text headers with a variable aren't supported yet.");
  } else if (headerFormat !== "NONE" && headerFormat !== "IMAGE") {
    reasons.push(`${FORMAT_LABEL[headerFormat] || headerFormat} headers aren't supported yet (only image headers are).`);
  }

  const bodyVars = countVars(body?.text);
  if (bodyVars.named || String(tpl.parameter_format || "").toUpperCase() === "NAMED") {
    reasons.push("Named variables aren't supported yet (only {{1}}, {{2}}, …).");
  }

  const buttons = [];
  for (const b of Array.isArray(buttonsComp?.buttons) ? buttonsComp.buttons : []) {
    const type = String(b.type || "").toUpperCase();
    // Destinations are kept because they change what recipients get; example values are not.
    buttons.push({
      type,
      text: String(b.text || "").slice(0, 40),
      ...(b.url !== undefined ? { url: String(b.url).slice(0, 2000) } : {}),
      ...(b.phone_number !== undefined ? { phone_number: String(b.phone_number).slice(0, 30) } : {}),
    });
    if (type === "QUICK_REPLY" || type === "PHONE_NUMBER") continue;
    if (type === "URL") {
      if (/\{\{/.test(String(b.url || ""))) reasons.push("URL buttons with a variable aren't supported yet.");
      continue;
    }
    reasons.push(`${type.replace(/_/g, " ").toLowerCase()} buttons aren't supported yet.`);
  }

  for (const c of components) {
    const t = String(c.type || "").toUpperCase();
    if (!["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(t)) reasons.push(`${t.toLowerCase()} components aren't supported yet.`);
  }

  const footer = components.find((c) => String(c.type).toUpperCase() === "FOOTER");
  const headerText = headerFormat === "TEXT" ? String(header?.text || "") : "";
  const footerText = footer ? String(footer.text || "") : "";
  // Everything that changes what a recipient receives, in a fixed shape for freezing and comparing.
  const content = {
    header: { format: headerFormat, text: headerText },
    body: { text: body?.text || "" },
    footer: { text: footerText },
    buttons: buttons.map((b) => ({ type: b.type, text: b.text, url: b.url ?? null, phone_number: b.phone_number ?? null })),
  };
  return {
    content,
    footerText,
    bodyText: body?.text || "",
    bodyParamCount: bodyVars.count,
    hasHeaderMedia: headerFormat !== "NONE" && headerFormat !== "TEXT",
    headerFormat,
    headerText,
    headerParamCount,
    buttons,
    unsupportedReason: [...new Set(reasons)].join(" ") || null,
  };
}

// Names the parts that differ between two frozen content objects ([] when identical).
export function contentDifferences(a, b) {
  if (!a || !b) return ["template"];
  const diffs = [];
  if (a.header?.format !== b.header?.format) diffs.push("header type");
  if ((a.header?.text || "") !== (b.header?.text || "")) diffs.push("header text");
  if ((a.body?.text || "") !== (b.body?.text || "")) diffs.push("body");
  if ((a.footer?.text || "") !== (b.footer?.text || "")) diffs.push("footer");
  if (JSON.stringify(a.buttons || []) !== JSON.stringify(b.buttons || [])) diffs.push("buttons");
  return diffs;
}
