# Springboard v1: open unknowns (update 2, with the fresh build)

This file goes with every handover. An item leaves it only after it has been checked against its source: the code, official Meta or Cloudflare docs, a real test, or your answer.

**Status:** OPEN means not checked yet. RESOLVED means checked, with the source given. VERIFY-LIVE means it can only be confirmed with your real Meta and Cloudflare setup.

## A. Verified during this build

| # | Item | How it was checked |
|---|---|---|
| V1 | The Worker config is valid and bundles | `wrangler deploy --dry-run` with wrangler 4.42.0, using filled-in test names |
| V2 | It runs in the real Workers runtime (workerd) | Local `wrangler dev` with local D1 and queue. Checked: login, the signed webhook (200), an unsigned webhook (401), the verify handshake, a campaign going through the real queue, and the inbox |
| V3 | The admin script works against D1 | `create-account`, `reset-password` (both old sessions returned 401 afterwards), `unsuppress` and `list-accounts`, all run with `--local` |
| V4 | Isolation, suppression, signature check, no fallback, preview = launch | 52 automated tests. I removed two guards on purpose and confirmed the tests caught it |
| V5 | All screens render with no script errors | Browser walkthrough with screenshots at desktop and phone width |

## B. Meta: confirm against the live setup

| # | Unknown | Why it matters | Status |
|---|---|---|---|
| M1 | The hex encoding of `X-Hub-Signature-256`. The docs imply it through an example but don't state it. | If wrong, every real webhook returns 401 | VERIFY-LIVE at go-live step 5 (the first real webhook) |
| M2 | Stop payload shape. The docs give only a "resume" example and a field table. The code expects `user_preferences[].value = "stop"` and `category = "marketing_messages"` | If wrong, opt-outs would not suppress | VERIFY-LIVE at go-live step 8 (tap the opt-out button) |
| M2c | `wa_id` can be missing for users who hide their number (the username feature). Those opt-outs can't be matched to a contact and are only logged | Such a user could keep receiving campaigns | OPEN: how often this happens is unknown |
| M3 | Whether Meta itself blocks marketing messages after a stop | Not needed for correctness, because Springboard suppresses anyway | OPEN (no impact) |
| M5 | Whether templates can be shared across WABAs. The code assumes not and checks per WABA, which is the safe choice | none | OPEN (no impact) |
| M6 | Which token type to use: a permanent system-user token or another kind, and its scope | A short-lived token would break sending when it expires | OPEN: not yet read from official docs |
| M8 | The Graph API version (`v23.0`), taken from the current docs examples | An old version could be retired by Meta | VERIFY-LIVE; it can be changed in `wrangler.toml` |
| M9 | Meta's own messaging tier limits per number | A campaign larger than the tier allows fails partway | OPEN |
| M10 | Nothing has been sent through the real Meta API. Every Graph call was faked in tests, and the sandbox couldn't reach Meta | Real error shapes could differ | VERIFY-LIVE at go-live step 8 |

## C. For you to answer

| # | Unknown | Status |
|---|---|---|
| U1 | Same Meta app as Alma, or a new one? The code supports one Meta app: one `META_APP_SECRET`, one webhook URL. A future number under a different Meta app would need a code change | OPEN |
| U4 | Cloudflare plan. Queues and cron triggers must be available on the new account's plan | OPEN: not checked against Cloudflare pricing docs |
| U5 | The 10-character password minimum and the 7-day session length. I chose these; change them if you want | OPEN: your call |

## D. Accepted v1 limits (decided, listed for visibility)

- Opt-out comes only from Meta's button and its stop/resume events. A typed "STOP" isn't acted on.
- There's no login rate limiting or CSRF token. Cookies are SameSite=Strict and HttpOnly. This is parked.
- Media messages that come in are stored as placeholders like `[image]`, and the media isn't downloaded.
- Templates with media headers can't be used in campaigns.
- Nothing can be deleted in the app.

## E. Image-header templates (added 10 Nov 2026)

| # | Unknown | Status |
|---|---|---|
| I1 | Your actual template's definition. Its header type was confirmed as image, but its JSON wasn't inspected. If it has a component this app doesn't support (for example a URL button with a variable), it shows under "cannot be used here" with the reason. | OPEN: check after "Refresh from Meta" |
| I2 | Whether a media id uploaded through one number works for another number in the same WABA. The docs don't say, so the code treats it as tied to the uploading number. | OPEN (safe default) |
| I3 | The send-time JSON for an image header by `id`. The docs show the `link` form and say `id` is allowed. The code sends `{"type":"header","parameters":[{"type":"image","image":{"id":"…"}}]}` | VERIFY-LIVE: first real image send |
| I4 | Meta's real upload response and error shapes, and whether Meta re-validates image dimensions. Only a local fake was used. | VERIFY-LIVE |
| I5 | The 30-day lifetime is Meta's documented figure. The app does not ask Meta about an id's remaining life. | ACCEPTED (2-day margin) |
| I6 | Meta's download URL hosts are only allow-listed for the preview stream (fbsbx.com, facebook.com, fbcdn.net, whatsapp.net) | VERIFY-LIVE: first preview |

## F. After the review corrections (11 Nov 2026)

| # | Item | Status |
|---|---|---|
| F1 | Image validation reads the file HEADER only. Truncated or corrupt files with a valid header pass, and there's no dimension cap. Your decision on a fuller check is held. | OPEN (decision) |
| F2 | Whether your approval image (`header_handle`) can be reused at send time. Nothing assumes either way; the current journey still asks for a fresh upload. Waits on the read-only diagnostic. | OPEN (diagnostic) |
| F3 | The freshness check uses Meta's `name`/`language` filters on v23.0. This hasn't been checked live, including Meta's exact or partial matching and the response shape. | VERIFY-LIVE |
| F4 | Real Meta behaviour for redirects, download sizes and timeouts on media downloads. Only fake responses were used. | VERIFY-LIVE |
| F5 | Whether the blocked text-template features would actually have failed on `main`. This is inferred from Meta's docs and wasn't tested live. | VERIFY-LIVE |
| F6 | No live template response, media upload or send has been demonstrated in any delivery so far. | OPEN |

## G. Incoming media and saved images (12 Nov 2026)

| # | Item | Status |
|---|---|---|
| G1 | The format of Meta's webhook `sha256` (hex or base64) isn't specified. Both are compared, and a mismatch is recorded but doesn't block storing. | VERIFY-LIVE |
| G2 | Real incoming downloads, R2 behaviour and audio playback on real devices. Only fakes were used, and the synthetic audio in the screenshots doesn't actually play. | VERIFY-LIVE |
| G3 | Whether older iPhones play OGG/Opus voice notes. A Download link is always shown as a fallback. | VERIFY-LIVE |
| G4 | Storage growth and cost with "keep forever". Current R2 pricing wasn't checked. | OPEN |
| G5 | Reusing your approval image (`header_handle`). Not built; waits on the diagnostic. | OPEN |
| G6 | `MEDIA_BUCKET` must be created and named in `wrangler.toml` before deploying. A deploy with the placeholder will fail. | YOUR STEP |
