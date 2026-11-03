// Meta webhook signature check.
// Source: developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
// Header "X-Hub-Signature-256: sha256=<hash>", HMAC-SHA256 of the POST body keyed with the app secret.
// We hash the raw request bytes (never re-serialised JSON) and compare in constant time.

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeSignature(appSecret, rawBody) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, rawBody));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isValidSignature(appSecret, rawBody, header) {
  if (!appSecret || !header || typeof header !== "string") return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match) return false;
  const expected = await computeSignature(appSecret, rawBody);
  return constantTimeEqual(expected, match[1].toLowerCase());
}
