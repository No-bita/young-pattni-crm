// Normalises a WhatsApp webhook body into plain events. No database access here.
// Sources (official Meta docs):
//   statuses: .../webhooks/reference/messages/status
//   user_preferences: developers.secure.facebook.com/docs/whatsapp/cloud-api/webhooks/user_preferences

function inboundText(m) {
  if (m.type === "text") return m.text?.body ?? "";
  if (m.type === "button") return m.button?.text ?? "[button]";
  if (m.type === "interactive") {
    return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[interactive]";
  }
  // Media captions live inside the media object (e.g. message.image.caption), not on the message.
  if (m.type === "image") return m.image?.caption || "[image]";
  if (m.type === "audio") return m.audio?.voice ? "[voice note]" : "[audio]";
  const media = m.type && m[m.type];
  if (media && typeof media === "object" && media.caption) return media.caption;
  return `[${m.type || "message"}]`;
}

// Image and audio references from the webhook. `url` is deliberately ignored: Meta marks it as a
// gradual-rollout field and download links expire after 5 minutes; the media id is what's kept.
// Source: developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/image (and /audio)
function inboundMedia(m) {
  if (m.type !== "image" && m.type !== "audio") return null;
  const o = m[m.type];
  if (!o?.id) return null;
  return {
    kind: m.type,
    metaMediaId: String(o.id),
    mimeType: o.mime_type ? String(o.mime_type).slice(0, 100) : null,
    sha256: o.sha256 ? String(o.sha256).slice(0, 200) : null,
    voice: m.type === "audio" && o.voice === true,
  };
}

export function parseWebhook(body) {
  const out = { statuses: [], messages: [], preferences: [] };
  if (!body || typeof body !== "object" || body.object !== "whatsapp_business_account") return out;

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = change?.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null;

      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        if (!s?.id || !s?.status) continue;
        const errors = Array.isArray(s.errors) ? s.errors : [];
        out.statuses.push({
          phoneNumberId,
          wamid: String(s.id),
          status: String(s.status).toLowerCase(),
          error: errors.length
            ? errors.map((e) => `${e.title || e.message || "Error"} (${e.code ?? "unknown"})`).join("; ")
            : null,
        });
      }

      const names = new Map();
      for (const ct of Array.isArray(value.contacts) ? value.contacts : []) {
        if (ct?.wa_id) names.set(String(ct.wa_id), ct.profile?.name || "");
      }

      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        if (!m?.id || !m?.from) continue;
        out.messages.push({
          phoneNumberId,
          wamid: String(m.id),
          from: String(m.from).replace(/\D/g, ""),
          profileName: names.get(String(m.from)) || "",
          text: inboundText(m),
          media: inboundMedia(m),
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
        });
      }

      for (const p of Array.isArray(value.user_preferences) ? value.user_preferences : []) {
        if (p?.category !== "marketing_messages") continue;
        const v = String(p.value || "").toLowerCase();
        if (v !== "stop" && v !== "resume") continue;
        out.preferences.push({
          phoneNumberId,
          waId: p.wa_id ? String(p.wa_id).replace(/\D/g, "") : null, // can be absent (username users)
          value: v,
        });
      }
    }
  }
  return out;
}
