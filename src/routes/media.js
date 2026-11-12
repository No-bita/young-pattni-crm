// Authenticated image upload for image-header templates. The browser never sees Meta's media id,
// the access token, or Meta's temporary download URL.
import { Hono } from "hono";
import { all, one, newId, nowIso } from "../lib/db.js";
import { accountId } from "../lib/http.js";
import { readBodyLimited, BodyError } from "../lib/body.js";
import { getActiveSender } from "../lib/send.js";
import { uploadMedia, fetchMediaBytes, GraphError } from "../whatsapp/graph.js";
import {
  MAX_IMAGE_BYTES, MAX_UPLOAD_REQUEST_BYTES, MEDIA_ID_LIFETIME_MS, PREVIEW_FETCH_TIMEOUT_MS, PREVIEW_MAX_BYTES, MediaError, inspectImage, sha256Hex, getOwnedAsset, presentAsset,
} from "../lib/media.js";

const media = new Hono();
const overLimit = (n) => `This image is ${n.toLocaleString("en-US")} bytes, over WhatsApp's 5 MB limit (${MAX_IMAGE_BYTES.toLocaleString("en-US")} bytes).`;

function cleanName(name) {
  return String(name || "image").replace(/[^\w.\- ]+/g, "_").slice(0, 80);
}

media.post("/", async (c) => {
  const sender = await getActiveSender(c.env.DB, accountId(c));
  if (!sender) return c.json({ error: "Activate a WhatsApp number first." }, 409);

  // Whole request (file + form overhead + any other fields) is capped while it is read.
  const contentType = c.req.header("Content-Type") || "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    return c.json({ error: "Send the image as a file upload.", code: "BAD_UPLOAD" }, 400);
  }
  let raw;
  try {
    raw = await readBodyLimited(c.req.raw, MAX_UPLOAD_REQUEST_BYTES);
  } catch (e) {
    if (e instanceof BodyError) {
      const msg = e.code === "TOO_LARGE" ? `The upload is larger than WhatsApp's 5 MB image limit (${MAX_IMAGE_BYTES.toLocaleString("en-US")} bytes).` : e.message;
      return c.json({ error: msg, code: e.code }, e.status);
    }
    throw e;
  }
  let form;
  try {
    form = await new Response(raw, { headers: { "Content-Type": contentType } }).formData();
  } catch {
    return c.json({ error: "The upload could not be read. Try again.", code: "BAD_UPLOAD" }, 400);
  }
  const keys = [...form.keys()];
  if (keys.length !== 1 || keys[0] !== "file") {
    return c.json({ error: "Send exactly one image file and nothing else.", code: "BAD_UPLOAD" }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return c.json({ error: "Choose an image file.", code: "BAD_UPLOAD" }, 400);
  }
  if (file.size === 0) return c.json({ error: "The file is empty.", code: "BAD_UPLOAD" }, 400);
  if (file.size > MAX_IMAGE_BYTES) {
    return c.json({ error: overLimit(file.size), code: "TOO_LARGE" }, 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let info;
  try {
    info = inspectImage(bytes);
  } catch (e) {
    if (e instanceof MediaError) return c.json({ error: e.message, code: e.code }, 415);
    throw e;
  }
  const declared = String(file.type || "").toLowerCase();
  if (declared && declared !== info.mimeType && !(declared === "image/jpg" && info.mimeType === "image/jpeg")) {
    return c.json({ error: `The file's contents are ${info.mimeType} but it is labelled ${declared}. Save it again as a JPEG or PNG.`, code: "TYPE_MISMATCH" }, 415);
  }

  let mediaId;
  try {
    mediaId = await uploadMedia(c.env, sender, { bytes, mimeType: info.mimeType, filename: cleanName(file.name) });
  } catch (e) {
    return c.json({ error: `Meta did not accept the image: ${e instanceof GraphError ? e.message : "upload failed"}`, code: "META_UPLOAD_FAILED" }, 502);
  }

  const id = newId("med");
  const uploadedAt = new Date();
  const expiresAt = new Date(uploadedAt.getTime() + MEDIA_ID_LIFETIME_MS).toISOString();
  // Keep the original privately so it can be uploaded to Meta again later (policy B).
  // Without MEDIA_BUCKET configured, the image is Meta-only and keeps the 30-day rules.
  let r2Key = null;
  if (c.env.MEDIA_BUCKET) {
    r2Key = `assets/${sender.account_id}/${id}`;
    try {
      await c.env.MEDIA_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: info.mimeType } });
    } catch {
      return c.json({ error: "The image reached Meta but could not be saved in the CRM's storage. Try again.", code: "STORAGE_FAILED" }, 502);
    }
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO media_assets (id, account_id, sender_id, kind, mime_type, byte_size, sha256, width, height, original_name, meta_media_id, uploaded_at, expires_at, created_at, r2_key)
       VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, sender.account_id, sender.id, info.mimeType, bytes.length, await sha256Hex(bytes), info.width, info.height,
      cleanName(file.name), mediaId, uploadedAt.toISOString(), expiresAt, nowIso(), r2Key),
    c.env.DB.prepare(
      "INSERT INTO media_meta_uploads (id, account_id, asset_id, sender_id, meta_media_id, uploaded_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(newId("mmu"), sender.account_id, id, sender.id, mediaId, uploadedAt.toISOString(), expiresAt),
  ]);
  const asset = await getOwnedAsset(c.env.DB, sender.account_id, id);
  return c.json({ asset: presentAsset(asset, sender.display_number) }, 201);
});

// Saved images of this account (stored copies only), newest first, for reuse across campaigns.
media.get("/", async (c) => {
  const rows = await all(c.env.DB, "SELECT * FROM media_assets WHERE account_id = ? AND r2_key IS NOT NULL ORDER BY created_at DESC LIMIT 50", accountId(c));
  return c.json({ assets: rows.map((a) => presentAsset(a)) });
});

media.get("/:id", async (c) => {
  const asset = await getOwnedAsset(c.env.DB, accountId(c), c.req.param("id"));
  if (!asset) return c.json({ error: "Image not found." }, 404);
  const sender = await one(c.env.DB, "SELECT display_number FROM senders WHERE id = ? AND account_id = ?", asset.sender_id, asset.account_id);
  return c.json({ asset: presentAsset(asset, sender?.display_number) });
});

// Preview for the signed-in account's own image.
// Stored images stream from private R2. Meta-only images (uploaded before storage existed): the Worker
// fetches from Meta (no redirects, 10-second deadline, 5 MB cap) and buffers it for this one response.
media.get("/:id/preview", async (c) => {
  const asset = await getOwnedAsset(c.env.DB, accountId(c), c.req.param("id"));
  if (!asset) return c.json({ error: "Image not found." }, 404);
  const previewHeaders = { "Content-Type": asset.mime_type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" };
  if (asset.r2_key && c.env.MEDIA_BUCKET) {
    const obj = await c.env.MEDIA_BUCKET.get(asset.r2_key);
    if (obj) return new Response(obj.body, { headers: previewHeaders });
  }
  if (Date.now() >= Date.parse(asset.expires_at)) return c.json({ error: "Meta no longer keeps this image (30 days passed).", code: "MEDIA_EXPIRED" }, 410);
  const sender = await one(c.env.DB, "SELECT * FROM senders WHERE id = ? AND account_id = ?", asset.sender_id, asset.account_id);
  if (!sender) return c.json({ error: "Image not found." }, 404);
  try {
    const { bytes } = await fetchMediaBytes(c.env, sender, asset.meta_media_id, { timeoutMs: PREVIEW_FETCH_TIMEOUT_MS, maxBytes: PREVIEW_MAX_BYTES });
    return new Response(bytes, {
      headers: {
        "Content-Type": asset.mime_type, // our validated type, not whatever the remote says
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  } catch (e) {
    return c.json({ error: `Could not load the image from Meta: ${e instanceof GraphError ? e.message : "error"}` }, 502);
  }
});

export default media;
