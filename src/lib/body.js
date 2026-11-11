// Reads a request body with a hard byte limit, counting bytes as they arrive. Nothing beyond the
// limit is buffered: reading stops and the stream is cancelled as soon as the limit is passed.
// A Content-Length header is only used to refuse early; it is never trusted as the real size.

export class BodyError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function readBodyLimited(request, maxBytes) {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    try { await request.body?.cancel(); } catch { /* ignore */ }
    throw new BodyError("The upload is too large.", "TOO_LARGE", 413);
  }
  if (!request.body) throw new BodyError("The upload is empty.", "BAD_UPLOAD", 400);

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new BodyError("The upload is too large.", "TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof BodyError) throw e;
    throw new BodyError("The upload was interrupted before it finished. Try again.", "INTERRUPTED", 400);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) { out.set(ch, o); o += ch.byteLength; }
  return out;
}

// Reads at most maxBytes from a fetch Response body, with the same early-stop behaviour.
export async function readResponseLimited(response, maxBytes) {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw new BodyError("The response is too large.", "TOO_LARGE", 502);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new BodyError("The response is too large.", "TOO_LARGE", 502);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) { out.set(ch, o); o += ch.byteLength; }
  return out;
}
