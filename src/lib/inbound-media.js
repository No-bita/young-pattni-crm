// Incoming photos and voice notes: recorded by the webhook, downloaded in the background through the
// receiving number's token, checked, and kept privately in R2 (MEDIA_BUCKET). Nothing is deleted
// automatically (owner decision). Meta keeps webhook media ids downloadable for 7 days only.
import { all, one, run, newId, nowIso } from "./db.js";
import { fetchMediaBytes, GraphError } from "../whatsapp/graph.js";
import { sha256Hex } from "./media.js";

export const INBOUND_LIMITS = { image: 5 * 1024 * 1024, audio: 16 * 1024 * 1024 }; // Meta's documented maximums
export const INBOUND_DOWNLOAD_TIMEOUT_MS = 20 * 1000;
export const INBOUND_MAX_ATTEMPTS = 3;
export const META_INBOUND_RETENTION_MS = 7 * 86400 * 1000; // Meta: webhook media ids expire after 7 days

// Called by the webhook for a NEW message only. Must stay fast: one insert and one queue send.
export async function recordInboundMedia(env, sender, messageId, media, receivedAt) {
  const id = newId("inm");
  const ts = nowIso();
  await run(
    env.DB,
    `INSERT INTO inbound_media (id, account_id, message_id, sender_id, kind, voice, meta_media_id, declared_mime_type, declared_sha256, status, received_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(message_id) DO NOTHING`,
    id, sender.account_id, messageId, sender.id, media.kind, media.voice ? 1 : 0, media.metaMediaId,
    media.mimeType, media.sha256, receivedAt, ts,
  );
  try {
    await env.CAMPAIGN_QUEUE.send({ type: "inbound_media", id, accountId: sender.account_id });
  } catch (e) {
    // The scheduler re-queues pending rows, so a failed send here only delays the download.
    console.warn("[inbound-media] could not queue download; the scheduler will retry", e?.message);
  }
}

function startsWith(b, bytes, offset = 0) {
  return bytes.every((v, i) => b[offset + i] === v);
}

// Identifies the real format from the bytes. Returns a content type from a fixed allowlist, or null.
export function sniffInbound(kind, bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 12) return null;
  if (kind === "image") {
    if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    return null;
  }
  if (startsWith(b, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";                       // "OggS" (voice notes: Opus)
  if (startsWith(b, [0x23, 0x21, 0x41, 0x4d, 0x52])) return "audio/amr";                 // "#!AMR"
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) return "audio/mp4";                    // "....ftyp" (M4A/MP4 audio)
  if (startsWith(b, [0x49, 0x44, 0x33]) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return "audio/mpeg"; // ID3 / MPEG frame
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "audio/aac";                       // ADTS AAC
  return null;
}

function base64(bytesHex) {
  const bin = bytesHex.match(/../g).map((h) => String.fromCharCode(parseInt(h, 16))).join("");
  return btoa(bin);
}

// Meta's sha256 format isn't specified as hex or base64; both are compared. NULL = nothing to compare.
export function shaMatches(hex, declared) {
  if (!declared) return null;
  const d = String(declared).trim();
  if (d.toLowerCase() === hex) return 1;
  const b64 = base64(hex);
  return d === b64 || d.replace(/=+$/, "") === b64.replace(/=+$/, "") ? 1 : 0;
}

const TRANSIENT = new Set(["TIMEOUT", "NETWORK"]);

// Queue step. Returns "stored" | "failed" | "unavailable" | "retry" | "skipped".
export async function processInboundMedia(env, { id, accountId }) {
  const db = env.DB;
  const claimed = await run(db, "UPDATE inbound_media SET status = 'downloading', attempts = attempts + 1, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'pending'", nowIso(), id, accountId);
  if (!claimed) return "skipped";
  const row = await one(db, "SELECT * FROM inbound_media WHERE id = ? AND account_id = ?", id, accountId);
  const settle = (status, fields = {}) => run(
    db,
    `UPDATE inbound_media SET status = ?, error = ?, stored_mime_type = COALESCE(?, stored_mime_type), byte_size = COALESCE(?, byte_size),
            sha256 = COALESCE(?, sha256), sha256_matches_meta = COALESCE(?, sha256_matches_meta), r2_key = COALESCE(?, r2_key),
            stored_at = COALESCE(?, stored_at), updated_at = ? WHERE id = ? AND account_id = ?`,
    status, fields.error ?? null, fields.mime ?? null, fields.size ?? null, fields.sha ?? null, fields.match ?? null, fields.key ?? null,
    fields.storedAt ?? null, nowIso(), id, accountId,
  );

  if (Date.now() - Date.parse(row.received_at) > META_INBOUND_RETENTION_MS) {
    await settle("unavailable", { error: "Meta keeps incoming media for 7 days; this one was not saved in time." });
    return "unavailable";
  }
  if (!env.MEDIA_BUCKET) {
    await settle("failed", { error: "Media storage (MEDIA_BUCKET) is not set up." });
    return "failed";
  }
  const sender = await one(db, "SELECT * FROM senders WHERE id = ? AND account_id = ?", row.sender_id, accountId);
  if (!sender) {
    await settle("failed", { error: "The receiving number is no longer on this account." });
    return "failed";
  }

  let bytes;
  try {
    ({ bytes } = await fetchMediaBytes(env, sender, row.meta_media_id, { timeoutMs: INBOUND_DOWNLOAD_TIMEOUT_MS, maxBytes: INBOUND_LIMITS[row.kind] }));
  } catch (e) {
    const code = e instanceof GraphError ? e.code : "NETWORK";
    const transient = TRANSIENT.has(code) || (e instanceof GraphError && e.status >= 500);
    if (transient && row.attempts < INBOUND_MAX_ATTEMPTS) {
      await run(db, "UPDATE inbound_media SET status = 'pending', error = ?, updated_at = ? WHERE id = ? AND account_id = ?", e.message, nowIso(), id, accountId);
      return "retry";
    }
    const tooLarge = code === "TOO_LARGE";
    await settle("failed", { error: tooLarge ? `Larger than WhatsApp's ${row.kind === "image" ? "5" : "16"} MB limit; not saved.` : `Could not download from Meta: ${e.message}` });
    return "failed";
  }

  const mime = sniffInbound(row.kind, bytes);
  if (!mime) {
    await settle("failed", { error: `The file is not a supported ${row.kind} format; not saved.` });
    return "failed";
  }
  const sha = await sha256Hex(bytes);
  const key = `inbound/${accountId}/${id}`;
  try {
    await env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  } catch (e) {
    if (row.attempts < INBOUND_MAX_ATTEMPTS) {
      await run(db, "UPDATE inbound_media SET status = 'pending', error = ?, updated_at = ? WHERE id = ? AND account_id = ?", `Storage error: ${e?.message}`, nowIso(), id, accountId);
      return "retry";
    }
    await settle("failed", { error: "Could not save to storage." });
    return "failed";
  }
  await settle("stored", { mime, size: bytes.length, sha, match: shaMatches(sha, row.declared_sha256), key, storedAt: nowIso() });
  return "stored";
}

// Cron: re-queue pending rows whose queue message may have been lost, recover stuck downloads,
// and mark rows past Meta's 7-day window as unavailable. Never downloads anything itself.
export async function sweepInboundMedia(env, now = new Date()) {
  const db = env.DB;
  const cutoff = new Date(now.getTime() - META_INBOUND_RETENTION_MS).toISOString();
  await run(db, "UPDATE inbound_media SET status = 'unavailable', error = 'Meta keeps incoming media for 7 days; this one was not saved in time.', updated_at = ? WHERE status IN ('pending', 'downloading') AND received_at < ?", nowIso(), cutoff);
  const stuck = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  await run(db, `UPDATE inbound_media SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
                   error = CASE WHEN attempts >= ? THEN 'Download did not finish after several attempts.' ELSE error END, updated_at = ?
                 WHERE status = 'downloading' AND updated_at < ?`, INBOUND_MAX_ATTEMPTS, INBOUND_MAX_ATTEMPTS, nowIso(), stuck);
  const quiet = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const rows = await all(db, "SELECT id, account_id FROM inbound_media WHERE status = 'pending' AND updated_at < ? LIMIT 50", quiet);
  for (const r of rows) {
    await run(db, "UPDATE inbound_media SET updated_at = ? WHERE id = ? AND account_id = ? AND status = 'pending'", nowIso(), r.id, r.account_id);
    try {
      await env.CAMPAIGN_QUEUE.send({ type: "inbound_media", id: r.id, accountId: r.account_id });
    } catch { /* next sweep tries again */ }
  }
}

export function presentInboundMedia(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    voice: Boolean(row.voice),
    status: row.status,
    mimeType: row.stored_mime_type,
    byteSize: row.byte_size,
    error: row.status === "stored" ? null : row.error,
    url: row.status === "stored" ? `/api/inbound-media/${row.id}` : null,
  };
}
