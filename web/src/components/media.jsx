import { useEffect, useRef, useState } from "react";
import { ApiError, apiUpload, fmtBytes, fmtDate } from "../api.js";
import { acceptUpload } from "../lib/uploadGuard.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function buttonLabel(b) {
  return b.text || b.type.replace(/_/g, " ").toLowerCase();
}

function buttonDestination(b) {
  if (b.type === "URL" && b.url) return b.url;          // shown as text, never as a clickable link
  if (b.type === "PHONE_NUMBER" && b.phoneNumber) return `Call ${b.phoneNumber}`;
  if (b.type === "QUICK_REPLY") return "Quick reply";
  return null;
}

// WhatsApp-style bubble: optional image or text header, rendered body, footer and buttons with
// their destinations. All values are rendered as text by React (no HTML injection).
export function MessageBubble({ body, imageUrl, needsImage, headerText, footer, buttons = [], imageAlt = "Header image", showDestinations = false }) {
  return (
    <div className="bub out media-bub">
      {needsImage && <PreviewImage src={imageUrl} alt={imageAlt} />}
      {headerText && <div className="bub-header">{headerText}</div>}
      <div className="bub-text">{body}</div>
      {footer && <div className="bub-footer">{footer}</div>}
      <div className="bmeta">6:56 pm <span className="ticks">✓✓</span></div>
      {buttons.length > 0 && (
        <div className="bub-buttons">
          {buttons.map((b, i) => (
            <span key={i}>
              {buttonLabel(b)}
              {showDestinations && buttonDestination(b) && <small className="bub-dest">{buttonDestination(b)}</small>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Image with a React-managed fallback (no direct DOM edits). Resets when the source changes.
export function PreviewImage({ src, alt = "Header image", missingText = "Image required", failedText = "Image no longer available from Meta" }) {
  const [failedSrc, setFailedSrc] = useState(null);
  if (!src) return <div className="bub-img placeholder" role="img" aria-label={missingText}>{missingText}</div>;
  if (failedSrc === src) return <div className="bub-img placeholder" role="img" aria-label={failedText}>{failedText}</div>;
  return <img className="bub-img" src={src} alt={alt} loading="lazy" onError={() => setFailedSrc(src)} />;
}

// Uploads one JPEG/PNG for an image-header template. The server re-checks everything;
// these browser checks only save a round trip. Stale completions are ignored: an upload started
// for another template, superseded by a newer upload, or made through a number that is no longer
// active is never attached.
export function ImageUpload({ asset, onUploaded, senderNumber, templateId, activeSenderId, onDiscarded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);
  const seq = useRef(0);
  const mounted = useRef(true);
  const currentTemplate = useRef(templateId);
  currentTemplate.current = templateId;
  useEffect(() => () => { mounted.current = false; }, []);

  const choose = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`This image is ${file.size.toLocaleString("en-US")} bytes, over WhatsApp's 5 MB limit (${MAX_IMAGE_BYTES.toLocaleString("en-US")} bytes).`);
      return;
    }
    if (file.type && !["image/jpeg", "image/png"].includes(file.type)) {
      setError("Only JPEG and PNG images can be used.");
      return;
    }
    const mySeq = ++seq.current;
    const forTemplateId = templateId;
    setBusy(true);
    try {
      const res = await apiUpload("/media", file);
      if (!mounted.current) return;
      const verdict = acceptUpload({
        seq: mySeq, currentSeq: seq.current, forTemplateId, currentTemplateId: currentTemplate.current,
        assetSenderId: res.asset.senderId, activeSenderId,
      });
      if (!verdict.ok) {
        onDiscarded?.(verdict.reason);
        if (verdict.reason === "sender_changed") setError("The active WhatsApp number changed during the upload. Upload the image again.");
        return;
      }
      onUploaded(res.asset, URL.createObjectURL(file), forTemplateId);
    } catch (err) {
      if (!mounted.current || mySeq !== seq.current) return;
      // A failed replacement keeps the previously attached image (if any).
      setError(`${err instanceof ApiError ? err.message : "Upload failed."}${asset ? " The previous image is still attached." : ""}`);
    } finally {
      if (mounted.current && mySeq === seq.current) setBusy(false);
    }
  };

  return (
    <div className="card stack upload-card">
      <div>
        <b>Header image</b>
        <div className="small mut">Required by this template. JPEG or PNG, 8-bit RGB, up to 5 MB. Uploaded to Meta through {senderNumber || "the active number"}.</div>
      </div>
      {error && <div className="alert bad" role="alert" style={{ marginBottom: 0 }}>{error}</div>}
      {asset && (
        <div className="small asset-meta">
          <div><b>{asset.originalName}</b> · {asset.width}×{asset.height} · {fmtBytes(asset.byteSize)}</div>
          <div className="mut">Uploaded {fmtDate(asset.uploadedAt)}. Meta documents uploads as lasting 30 days; this CRM treats the image as usable until {fmtDate(asset.usableUntil)} (2-day margin) and requires a campaign with it to start by {fmtDate(asset.latestStart)}.</div>
        </div>
      )}
      <input ref={input} type="file" accept="image/jpeg,image/png" onChange={choose} hidden aria-label="Choose header image" />
      <div>
        <button type="button" className={asset ? "secondary" : ""} disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Uploading…" : asset ? "Replace image" : "Upload image"}
        </button>
      </div>
    </div>
  );
    }
