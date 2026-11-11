// Decides whether a finished image upload may be attached. Pure logic, unit-tested in tests/.
// An upload is accepted only if it is the latest one started, it was started for the template
// that is still selected, and the image was uploaded through the number that is still active.
export function acceptUpload({ seq, currentSeq, forTemplateId, currentTemplateId, assetSenderId, activeSenderId }) {
  if (seq !== currentSeq) return { ok: false, reason: "superseded" };
  if (!forTemplateId || forTemplateId !== currentTemplateId) return { ok: false, reason: "template_changed" };
  if (activeSenderId && assetSenderId !== activeSenderId) return { ok: false, reason: "sender_changed" };
  return { ok: true };
}

// An attached image stays valid only while its number is still the active one.
export function assetStillValid(asset, activeSenderId) {
  return Boolean(asset) && (!activeSenderId || asset.senderId === activeSenderId);
}
