// Image assets for image-header templates (retention policy A, approved by the owner):
// the file is uploaded to Meta through ONE phone number and only Meta's media id is kept.
// Meta documents media ids as expiring after 30 days, so an asset is usable only until
// expires_at minus a safety margin, and a campaign must be able to finish sending
// (launch/schedule time + the queue bound) before that point.
import { one } from "./db.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;           // Meta: images up to 5 MB
export const MAX_UPLOAD_REQUEST_BYTES = MAX_IMAGE_BYTES + 64 * 1024; // whole upload request: file + form overhead (approved)
export const PREVIEW_FETCH_TIMEOUT_MS = 10 * 1000;         // approved: preview fetch from Meta
export const PREVIEW_MAX_BYTES = MAX_IMAGE_BYTES;          // approved: preview response cap
export const MEDIA_ID_LIFETIME_MS = 30 * 86400 * 1000;     // Meta: "Media IDs ... expire after 30 days"
export const SAFETY_MARGIN_MS = 2 * 86400 * 1000;          // approved margin: 2 days
export const QUEUE_BOUND_MS = 60 * 60 * 1000;              // queued sends older than 1h are settled as failed

// Readable UTC time for messages shown to people, e.g. "10 Nov 2026, 05:33 UTC".
export function fmtUtc(date) {
  const d = date instanceof Date ? date : new Date(date);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export class MediaError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32be(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }

// Identifies the real format from the bytes (never from the file name or the browser's label)
// and checks Meta's image rules: JPEG or PNG, 8-bit, RGB or RGBA.
// LIMITATION (decision held by the owner): this reads the file HEADER only. A truncated or
// corrupt file with a valid header passes; it does not prove the image decodes. Meta may
// still reject such a file at upload. No dimension cap is applied yet.
export function inspectImage(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 32) throw new MediaError("The file is too small to be an image.", "NOT_IMAGE");

  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG.every((v, i) => b[i] === v)) {
    if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") throw new MediaError("This PNG file is damaged.", "BAD_IMAGE");
    const width = u32be(b, 16);
    const height = u32be(b, 20);
    const bitDepth = b[24];
    const colorType = b[25];
    if (bitDepth !== 8) throw new MediaError(`This PNG uses ${bitDepth}-bit colour. WhatsApp needs 8-bit images.`, "BAD_IMAGE");
    if (colorType !== 2 && colorType !== 6) {
      throw new MediaError("This PNG is greyscale or uses a colour palette. WhatsApp needs an RGB or RGBA image.", "BAD_IMAGE");
    }
    if (!width || !height) throw new MediaError("This PNG file is damaged.", "BAD_IMAGE");
    return { mimeType: "image/png", width, height };
  }

  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) throw new MediaError("This JPEG file is damaged.", "BAD_IMAGE");
      const marker = b[o + 1];
      if (marker === 0xff) { o++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan before a frame header
      const len = u16be(b, o + 2);
      if (len < 2) throw new MediaError("This JPEG file is damaged.", "BAD_IMAGE");
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        const precision = b[o + 4];
        const height = u16be(b, o + 5);
        const width = u16be(b, o + 7);
        const components = b[o + 9];
        if (precision !== 8) throw new MediaError(`This JPEG uses ${precision}-bit colour. WhatsApp needs 8-bit images.`, "BAD_IMAGE");
        if (components !== 3) {
          throw new MediaError(components === 1 ? "This JPEG is greyscale. WhatsApp needs an RGB image." : "This JPEG uses CMYK or another colour mode. WhatsApp needs an RGB image.", "BAD_IMAGE");
        }
        if (!width || !height) throw new MediaError("This JPEG file is damaged.", "BAD_IMAGE");
        return { mimeType: "image/jpeg", width, height };
      }
      o += 2 + len;
    }
    throw new MediaError("This JPEG file is damaged.", "BAD_IMAGE");
  }

  throw new MediaError("This file is not a JPEG or PNG image (checked from its contents, not its name). Only JPEG and PNG images can be used.", "UNSUPPORTED_TYPE");
}

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function usableUntil(asset) {
  return new Date(Date.parse(asset.expires_at) - SAFETY_MARGIN_MS);
}

// The latest start time a media campaign may have with this asset.
export function latestStart(asset) {
  return new Date(usableUntil(asset).getTime() - QUEUE_BOUND_MS);
}

export async function getOwnedAsset(db, accountId, assetId) {
  if (!assetId) return null;
  return one(db, "SELECT * FROM media_assets WHERE id = ? AND account_id = ?", String(assetId), accountId);
}

// Why this asset cannot carry a send that must complete by `mustLastUntil`, or null.
export function assetBlocker(asset, { senderId, mustLastUntil }) {
  if (!asset) return { code: "MEDIA_MISSING", error: "This template needs an image. Upload one first." };
  if (asset.kind !== "image") return { code: "MEDIA_WRONG_TYPE", error: "This template needs an image header." };
  if (asset.sender_id !== senderId) {
    return { code: "MEDIA_WRONG_SENDER", error: "The image was uploaded through a different WhatsApp number. Upload it again on the active number." };
  }
  if (mustLastUntil.getTime() > usableUntil(asset).getTime()) {
    return {
      code: "MEDIA_EXPIRED",
      error: `The image can be used only until ${fmtUtc(usableUntil(asset))}: Meta documents uploads as lasting 30 days, and this CRM keeps a 2-day safety margin. Upload it again, or send earlier.`,
    };
  }
  return null;
}

export function presentAsset(a, senderNumber = null) {
  if (!a) return null;
  return {
    id: a.id,
    kind: a.kind,
    mimeType: a.mime_type,
    byteSize: a.byte_size,
    width: a.width,
    height: a.height,
    originalName: a.original_name,
    senderId: a.sender_id,
    senderNumber,
    uploadedAt: a.uploaded_at,
    expiresAt: a.expires_at,
    usableUntil: usableUntil(a).toISOString(),
    latestStart: latestStart(a).toISOString(),
    previewUrl: `/api/media/${a.id}/preview`,
  };
}
