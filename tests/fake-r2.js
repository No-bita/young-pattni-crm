// In-memory stand-in for a Cloudflare R2 bucket binding (only the calls this app uses).
export function makeR2() {
  const objects = new Map();
  const r2 = {
    objects,
    failPut: false,
    puts: 0,
    async put(key, value, opts = {}) {
      if (r2.failPut) throw new Error("fake R2 put failure");
      r2.puts++;
      const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { bytes, contentType: opts.httpMetadata?.contentType || null });
      return { key, size: bytes.length };
    },
    async get(key, opts = {}) {
      const o = objects.get(key);
      if (!o) return null;
      let bytes = o.bytes;
      if (opts.range) bytes = bytes.subarray(opts.range.offset, opts.range.offset + opts.range.length);
      return {
        key,
        size: o.bytes.length,
        httpMetadata: { contentType: o.contentType },
        body: new Response(bytes).body,
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
  };
  return r2;
}
