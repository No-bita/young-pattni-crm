// Serves a stored incoming photo or voice note to the signed-in account that owns it, straight from
// private R2 (streamed). Supports a single byte range so audio can seek and play on iPhones.
import { Hono } from "hono";
import { one } from "../lib/db.js";
import { accountId } from "../lib/http.js";

const inboundMedia = new Hono();

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start; let end;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; } // suffix range
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

inboundMedia.get("/:id", async (c) => {
  const row = await one(c.env.DB, "SELECT * FROM inbound_media WHERE id = ? AND account_id = ?", c.req.param("id"), accountId(c));
  if (!row) return c.json({ error: "Not found." }, 404);
  if (row.status !== "stored" || !row.r2_key) return c.json({ error: row.error || "Not saved yet.", status: row.status }, 409);
  if (!c.env.MEDIA_BUCKET) return c.json({ error: "Media storage is not set up." }, 503);

  const range = parseRange(c.req.header("Range"), row.byte_size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${row.byte_size}` } });
  const obj = await c.env.MEDIA_BUCKET.get(row.r2_key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!obj) return c.json({ error: "The stored file is missing." }, 410);

  const headers = {
    "Content-Type": row.stored_mime_type,              // from our own byte check, not from Meta
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
  };
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${row.byte_size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    return new Response(obj.body, { status: 206, headers });
  }
  headers["Content-Length"] = String(row.byte_size);
  return new Response(obj.body, { status: 200, headers });
});

export default inboundMedia;
