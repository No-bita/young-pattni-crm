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

async function call(env, sender, method, path, body) {
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
    });
  } catch {
    // Network failure: Meta never confirmed the message, so it is reported as failed (not retried).
    throw new GraphError("Could not reach Meta's WhatsApp API. The message was not confirmed as sent.", { code: "NETWORK" });
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

export async function sendTemplate(env, sender, { to, name, language, bodyParams }) {
  const components = bodyParams.length
    ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text: String(text) })) }]
    : [];
  const data = await call(env, sender, "POST", `${encodeURIComponent(sender.phone_number_id)}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name, language: { code: language }, components },
  });
  return data?.messages?.[0]?.id || null;
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

// Number of {{n}} body variables and a flag for media headers (which v1 does not send).
export function describeTemplate(tpl) {
  const components = Array.isArray(tpl.components) ? tpl.components : [];
  const body = components.find((c) => c.type === "BODY");
  const header = components.find((c) => c.type === "HEADER");
  const vars = new Set(String(body?.text || "").match(/\{\{\s*\d+\s*\}\}/g) || []);
  return {
    bodyText: body?.text || "",
    bodyParamCount: vars.size,
    hasHeaderMedia: Boolean(header && header.format && header.format !== "TEXT"),
  };
}
