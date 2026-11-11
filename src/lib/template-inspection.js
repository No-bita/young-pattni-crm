// One-template diagnostics only. No persistence, media download, or send path.
// Arbitrary upstream text and example values never enter the returned inventory.
export const INSPECTION_FIELDS = ["id", "name", "language", "status", "category", "components", "parameter_format", "last_updated_time"];
export const INSPECTION_MAX_BYTES = 262144;
export const INSPECTION_TIMEOUT_MS = 10000;

// Fixed reason codes only: never include upstream values, keys or identifiers.
const RESPONSE_REASONS = new Set([
  "CONTENT_TYPE", "BODY_MISSING", "UTF8_INVALID", "JSON_INVALID", "ROOT_TYPE",
  "ID_MISSING", "ID_MISMATCH", "COMPONENTS_TYPE", "COMPONENTS_LIMIT", "COMPONENT_TYPE",
  "BUTTONS_TYPE", "BUTTONS_LIMIT", "BUTTON_TYPE", "HEADER_REFERENCES_LIMIT", "EXAMPLE_VALUES_LIMIT",
]);
export const safeInspectionReason = (value) => RESPONSE_REASONS.has(value) ? value : null;
const invalidResponse = (reason) => new InspectionError("INVALID_RESPONSE", 502, null, null, reason);

export class InspectionError extends Error {
  constructor(code, status = 502, metaCode = null, metaSubcode = null, reason = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.metaCode = Number.isSafeInteger(metaCode) ? metaCode : null;
    this.metaSubcode = Number.isSafeInteger(metaSubcode) ? metaSubcode : null;
    this.reason = code === "INVALID_RESPONSE" ? safeInspectionReason(reason) : null;
  }
}

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const state = (v, present) => !present ? "absent" : v === null ? "null" : "present";
const kind = (v) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
const known = (v, values) => values.includes(v) ? v : "OTHER";
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const COMPONENT_KEYS = ["type", "format", "text", "example", "buttons", "add_security_recommendation", "code_expiration_minutes"];
const EXAMPLE_KEYS = ["header_handle", "header_text", "body_text", "header_text_named_params", "body_text_named_params"];
const BUTTON_KEYS = ["type", "text", "url", "phone_number", "example"];
function keys(o, allowed) {
  return { present: allowed.filter((k) => own(o, k)), otherCount: Object.keys(o).filter((k) => !allowed.includes(k)).length };
}
function list(v, max, typeReason, limitReason) {
  if (!Array.isArray(v)) throw invalidResponse(typeReason);
  if (v.length > max) throw invalidResponse(limitReason);
  return v;
}
function textShape(v, present) {
  const out = { state: state(v, present), kind: present ? kind(v) : "absent" };
  if (typeof v === "string") {
    const vars = [...v.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
    out.length = v.length;
    out.variableCount = new Set(vars).size;
    out.positionalCount = new Set(vars.filter((s) => /^\d+$/.test(s))).size;
    out.namedCount = new Set(vars.filter((s) => !/^\d+$/.test(s))).size;
  }
  return out;
}
function valueShape(v, depth = 0) {
  const out = { kind: kind(v) };
  if (typeof v === "string") out.length = v.length;
  if (Array.isArray(v)) {
    out.count = v.length;
    if (depth < 3) out.items = list(v, 40, null, "EXAMPLE_VALUES_LIMIT").map((x) => valueShape(x, depth + 1));
  } else if (object(v)) {
    out.fields = keys(v, ["param_name", "example"]);
    if (depth < 3) {
      for (const k of ["param_name", "example"]) if (own(v, k)) out[k] = valueShape(v[k], depth + 1);
    }
  }
  return out;
}
function reference(v) {
  if (typeof v !== "string") return { kind: kind(v) };
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      const h = u.hostname.toLowerCase();
      // Only Meta CDN hostnames are shown. Other hosts may themselves contain private labels.
      const meta = ["scontent.whatsapp.net", "lookaside.fbsbx.com", "platform-lookaside.fbsbx.com"].includes(h);
      return { kind: "url", scheme: u.protocol === "https:" ? "https" : "http", hostname: meta ? h : "hidden_non_meta_host" };
    } catch { return { kind: "invalid_url" }; }
  }
  if (/^\d+::/.test(v)) return { kind: "upload_handle" };
  if (/^\d+$/.test(v)) return { kind: "numeric_reference" };
  return { kind: "opaque_string" };
}
function exampleShape(c) {
  const v = c.example;
  const out = { state: state(v, own(c, "example")), kind: own(c, "example") ? kind(v) : "absent" };
  if (!object(v)) return out;
  out.fields = keys(v, EXAMPLE_KEYS);
  if (own(v, "header_handle")) {
    out.headerHandle = { state: state(v.header_handle, true), kind: kind(v.header_handle) };
    if (Array.isArray(v.header_handle)) out.headerHandle.items = list(v.header_handle, 10, null, "HEADER_REFERENCES_LIMIT").map(reference);
    else out.headerHandle.item = reference(v.header_handle);
  }
  for (const k of EXAMPLE_KEYS.filter((k) => k !== "header_handle")) {
    if (own(v, k)) out[k] = valueShape(v[k]);
  }
  return out;
}
function buttonShape(b) {
  if (!object(b)) throw invalidResponse("BUTTON_TYPE");
  return {
    type: known(b.type, ["QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE", "OTP", "FLOW", "CATALOG", "MPM"]),
    fields: keys(b, BUTTON_KEYS),
    label: textShape(b.text, own(b, "text")),
    destination: { urlPresent: own(b, "url"), phonePresent: own(b, "phone_number") },
    example: own(b, "example") ? valueShape(b.example) : { kind: "absent" },
  };
}
export function templateInventory(t) {
  if (!object(t)) throw invalidResponse("ROOT_TYPE");
  const componentsPresent = own(t, "components");
  const components = (componentsPresent ? list(t.components, 30, "COMPONENTS_TYPE", "COMPONENTS_LIMIT") : []).map((c) => {
    if (!object(c)) throw invalidResponse("COMPONENT_TYPE");
    const out = {
      type: known(c.type, ["HEADER", "BODY", "FOOTER", "BUTTONS"]),
      fields: keys(c, COMPONENT_KEYS),
      text: textShape(c.text, own(c, "text")),
      example: exampleShape(c),
    };
    if (own(c, "format")) out.format = known(c.format, ["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION", "GIF"]);
    if (own(c, "buttons")) out.buttons = list(c.buttons, 20, "BUTTONS_TYPE", "BUTTONS_LIMIT").map(buttonShape);
    return out;
  });
  return {
    requestedFields: INSPECTION_FIELDS,
    fields: keys(t, INSPECTION_FIELDS),
    missingFields: INSPECTION_FIELDS.filter((f) => !own(t, f)),
    status: own(t, "status") ? known(t.status, ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED", "ARCHIVED", "DELETED", "IN_APPEAL", "LIMIT_EXCEEDED", "PENDING_DELETION"]) : "ABSENT",
    parameterFormat: own(t, "parameter_format") ? known(t.parameter_format, ["NAMED", "POSITIONAL"]) : "ABSENT",
    lastUpdatedTimePresent: own(t, "last_updated_time"),
    components,
    componentsState: componentsPresent ? "present" : "absent",
    valuesRedacted: true,
    reuseVerified: false,
  };
}

export async function inspectMetaTemplate(env, sender, metaTemplateId) {
  const version = env.GRAPH_API_VERSION || "v23.0";
  if (!/^v\d{1,2}\.\d$/.test(version) || !/^\d{5,40}$/.test(String(metaTemplateId))) throw new InspectionError("INVALID_CONFIGURATION", 409);
  const token = env[`WA_TOKEN_${sender.token_ref}`];
  if (!token || typeof token !== "string") throw new InspectionError("CREDENTIAL_UNAVAILABLE", 409);
  const url = new URL(`https://graph.facebook.com/${version}/${metaTemplateId}`);
  url.searchParams.set("fields", INSPECTION_FIELDS.join(","));
  const controller = new AbortController();
  let timer;
  let reader;
  const perform = async () => {
    const res = await fetch(url.toString(), { method: "GET", redirect: "manual", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: controller.signal });
    if (res.redirected || (res.status >= 300 && res.status < 400)) throw new InspectionError("REDIRECT_REFUSED");
    const size = res.headers.get("Content-Length");
    if (size && (!/^\d+$/.test(size) || Number(size) > INSPECTION_MAX_BYTES)) throw new InspectionError("RESPONSE_TOO_LARGE");
    if (!/^(?:application\/json|text\/javascript)(?:\s*;|$)/i.test(res.headers.get("Content-Type") || "")) throw invalidResponse("CONTENT_TYPE");
    if (!res.body) throw invalidResponse("BODY_MISSING");
    reader = res.body.getReader();
    let total = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > INSPECTION_MAX_BYTES) throw new InspectionError("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw invalidResponse("UTF8_INVALID"); }
    let body;
    try { body = JSON.parse(text); }
    catch { throw invalidResponse("JSON_INVALID"); }
    if (!res.ok) throw new InspectionError("META_REQUEST_FAILED", 502, body?.error?.code, body?.error?.error_subcode);
    if (!object(body)) throw invalidResponse("ROOT_TYPE");
    if (!own(body, "id")) throw invalidResponse("ID_MISSING");
    if (String(body.id) !== String(metaTemplateId)) throw invalidResponse("ID_MISMATCH");
    return { graphVersion: version, requestCount: 1, inventory: templateInventory(body) };
  };
  try {
    return await Promise.race([
      perform(),
      new Promise((_, reject) => { timer = setTimeout(() => { reject(new InspectionError("META_TIMEOUT", 504)); controller.abort(); }, INSPECTION_TIMEOUT_MS); }),
    ]);
  } catch (e) {
    if (e instanceof InspectionError) throw e;
    throw new InspectionError("META_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* no upstream details logged */ } }
  }
}
