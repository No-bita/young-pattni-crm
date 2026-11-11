# Springboard v1

A WhatsApp campaign tool built fresh from the v9 handover. The old Springboard repo was used only as a reference: the PBKDF2 password format and the webhook parsing pattern carried over. Nothing from email, credits, documents or follow-ups is included.

- **Backend:** a Cloudflare Worker (Hono) with D1, a Cloudflare Queue for campaign sends, and a cron trigger (every minute) for scheduled campaigns.
- **Screens:** React, built with Vite into `web/dist` and served by the same Worker.
- **Accounts:** one shared login per customer account, created by you with `scripts/admin.mjs`. There is no signup.

Open questions are kept separately in `UNKNOWNS.md`. Read that before deploying.

## Layout

```
src/index.js            routes, queue consumer, cron
src/routes/*.js         auth, contacts, templates, senders (numbers), campaigns, inbox, webhook, admin
src/lib/send.js         the one gate every outbound message passes through.
src/lib/campaigns.js    audience, launch, queue processing, scheduler
src/whatsapp/*.js       Graph API client, signature check, webhook parser
migrations/0001_init.sql
scripts/admin.mjs       operator CLI: accounts, password reset, admin flag, unsuppress
web/                    React screens
tests/                  52 tests on a real SQLite copy of the schema, with Meta faked
```

## Run tests

Node 22.5 or later is needed (the tests use the built-in `node:sqlite`).

```
npm install
npm test
```

## Local run

```
npm install && npm --prefix web install
# Fill the REPLACE_ values in wrangler.toml (any names work locally), then:
npx wrangler d1 migrations apply DB --local
printf 'META_APP_SECRET=dev\nMETA_VERIFY_TOKEN=dev\nWA_TOKEN_MAIN=<token>\n' > .dev.vars
npm run admin -- create-account --name "Test" --login test@example.com --local
npm run dev        # builds the screens, serves on http://localhost:8787
```

## Going live (your steps, in order)

1. **Create the resources** in the NEW Springboard Cloudflare account: a D1 database and a Queue. Put their names and the database id into `wrangler.toml`, replacing every `REPLACE_` value. Choose the Worker name there too.
2. **Apply the schema** with `npm run db:migrate:remote`.
3. **Build and deploy:** run `npm --prefix web install && npm run build:web`, then `npx wrangler deploy`.
4. **Add the secrets.** Each `secret put` deploys a new version immediately, so this comes after step 1.
   - `npx wrangler secret put META_APP_SECRET`: the app secret of the Meta app that will send webhooks.
   - `npx wrangler secret put META_VERIFY_TOKEN`: any long random string.
   - `npx wrangler secret put WA_TOKEN_MAIN`: the access token for the first number. MAIN is your choice of name, and you enter the same name on the Number screen.
5. **Point Meta's webhook at the new Worker.** In the Meta App Dashboard, go to WhatsApp > Configuration.
   - Callback URL: `https://<your-worker-domain>/api/webhook`
   - Verify token: the same string as `META_VERIFY_TOKEN`
   - Subscribe to the **messages** and **user_preferences** fields.
6. **Create accounts** with `npm run admin -- create-account --name "Customer" --login customer@example.com`. Add `--admin` for your own operator account.
7. **Sign in as the customer account and set up the number.** On the WhatsApp number screen, add the number (token name, phone number ID, WhatsApp Business Account ID), run the test (optionally with a real test message to your own phone), then activate it.
8. **Test end to end** before messaging real contacts:
   - Send a campaign to your own number.
   - Reply to it.
   - Check that the delivery and read status updates arrive.
   - Tap the marketing opt-out button and check the contact shows as opted out.

## Operator script

```
npm run admin -- create-account --name "Acme" --login acme@example.com [--admin]
npm run admin -- reset-password --login acme@example.com      # ends every existing login for that account
npm run admin -- set-admin --login you@example.com --on|--off
npm run admin -- unsuppress --login acme@example.com --phone +919876543210
npm run admin -- list-accounts
```

The script targets the remote (production) database unless you add `--local`. Passwords are typed at a hidden prompt, and must be at least 10 characters.

## How each handover requirement is met

| v9 item | Where |
|---|---|
| 1. Signed webhooks only | `src/whatsapp/signature.js`: HMAC-SHA256 over the raw body bytes, constant-time compare; rejected requests write nothing. The verify token is a secret. |
| 2. No credits | No credit code, table, route or screen exists. |
| 3. Account isolation | Every data table has `account_id`, and every query filters by it. Tested with two accounts in `tests/isolation.test.js`, which includes a schema audit. |
| 4. One active sender, no fallback | One active number per account, enforced by a unique index. Each send uses only that number and its own token. A switch goes add → test → activate. Activation is refused while a campaign is scheduled or sending, or when draft campaigns' templates aren't approved on the new number's WABA. The old number is kept. |
| 5. Campaigns reach only the confirmed audience | The audience is an explicit stored list of contact ids, and an empty or missing audience blocks launch. Preview and launch use the same count function. Launch requires `confirmCount` to equal the current count. |
| 6. Opt-out suppression | Meta's `user_preferences` stop/resume events suppress or lift. Every send path (campaign, scheduled campaign, inbox reply, number test message) goes through `src/lib/send.js` or checks suppression itself. |
| 7. Own resources only | `wrangler.toml` holds placeholders only; there are no Alma, Collectr or Lekho names in the code. |
| 8. Isolation tests | `tests/isolation.test.js` |
| 9. No signup; you create accounts | No signup route exists; every signup-style path returns 404. `scripts/admin.mjs` shares the app's password code. Sessions are stored in the database, so a reset ends old logins. |
| 10. Delivery status in the Inbox | Status webhooks are matched by (account, number, message id), move only forward (sent → delivered → read), and record failures with Meta's error. |
| Limits | Each campaign is capped at `MAX_CAMPAIGN_AUDIENCE` (default 1,000). Sends are paced by the queue (one consumer, `SEND_INTERVAL_MS` = 100 ms, about 10 a second). |
| Scheduling | Campaigns can be sent now or scheduled up to 90 days ahead. Scheduled campaigns re-check the number and template when they fall due. |
| Inbox replies | Free text only within 24 hours of the contact's last message. |

## Behaviours to know

- A send is recorded before Meta is called. If the outcome is unknown (a crash or network failure), the message is marked failed and **never re-sent automatically**, so no one gets a duplicate.
- A "stop" from a number that isn't a contact yet creates an opted-out contact. Importing that number later can't make it messageable.
- Template variables are filled per campaign with either the contact's name (with a fallback you set for contacts without a name) or fixed text. Templates with media headers aren't supported in v1.
- Numbers without a country code are treated as Indian (+91).
- Deleting isn't supported anywhere in v1. Templates that disappear from Meta are marked MISSING, not removed.

## Image-header templates

You can pick an approved template whose header is an image, upload its image, preview the full message, and send or schedule it.

### Supported template shapes

- **Supported:** an IMAGE header, or a TEXT header with no variable; a body with `{{1}}`-style variables; an optional footer; and buttons that need no value at send time (quick reply, phone, URL without a variable).
- **Not supported:** anything else is listed under "cannot be used here", with its reason.
- **What changed for text templates:** see *Eligibility changes* below.

### Upload

`POST /api/media` (signed-in users only):

- **Size limits:** the whole request (file plus form overhead plus any other fields) is capped at 5 MB + 64 KB. The cap is enforced while the body arrives; `Content-Length` is used only to refuse early, never trusted. The file itself is capped at 5 MB. Exactly one field, `file`, is accepted. An interrupted upload is reported and nothing reaches Meta.
- **Image check (header only):** the format is read from the bytes (JPEG or PNG, 8-bit, RGB or RGBA). This check reads only the file's header, so a truncated or corrupt image with a valid header passes. Meta may still reject it, and no dimension cap is applied. Full decoding is an open decision.
- **Where the file goes:** straight to Meta through the active number. Only Meta's media id is kept, never the file itself, and the browser never sees the id.

### Preview

`/api/media/:id/preview`:

- The Worker fetches the image from Meta and sends it to the signed-in account that owns it. The response is buffered, not streamed.
- Safeguards: redirects aren't followed, so the token goes nowhere else; the whole fetch has a 10-second deadline; at most 5 MB is read. Nothing is cached in the CRM.
- **Limitation:** because the original file isn't kept, previews, including old Inbox images, stop loading once Meta drops the upload.

### Image lifetime: what's documented versus chosen

- **Documented by Meta:** an uploaded media id expires after 30 days.
- **Inferred by this CRM:** `expires_at` = upload time + 30 days. The clock starts at upload, not at launch. The CRM never asks Meta how long an id actually has left, and nothing renews it automatically.
- **Chosen by you (policy A, 10 Nov):** a 2-day safety margin, so an image is usable until upload + 28 days; and a 1-hour sending window. So the latest start for a campaign with that image is **upload + 27 days 23 hours**. Text-only campaigns can still be scheduled up to 90 days ahead.

### Template content checks

- **When content is frozen:** picking a template saves the parts that change what recipients get: header type and text, body, footer, and each button's type, label and destination.
- **Before launching or scheduling, and when a schedule starts,** the CRM asks Meta for that one template:
  - 5-second deadline.
  - If anything differs, nothing is sent, the changed parts are named, and you re-pick the template.
  - **If Meta can't be reached,** it uses the CRM's saved copy and records "NOT freshly checked". It never claims a fresh check it didn't make.
  - If Meta no longer has the template, it's marked missing.
- **While sending,** each send compares against the CRM's local copy only, not Meta.
- **Not stored:** example values, approval sample media and raw API responses.

### Sending window

- **When it ends:** every launched campaign gets a deadline of start + 1 hour, never later than the image's usable-until time.
- **In the queue consumer:** a recipient still queued at the deadline isn't sent and is counted as "not sent because the window ended". The deadline doesn't guarantee everyone gets the message.

### Other rules

- **Number changes:** the image is pinned to the number it was uploaded through. After a number switch, the screen drops the attached image. An upload that was started for another template, replaced by a newer upload, or made through a number that's no longer active is never attached.
- **Send history:** each message stores which image it carried (`messages.media_asset_id`), never a download URL. Nothing is deleted from Meta automatically.
- **Number screen test:** it still offers only text-only templates without variables.

### Eligibility changes for existing text templates

On `main`, the picker showed these templates, but the CRM only ever sent `{{1}}`-style body variables. Meta's docs require a value for each of these, so per the docs they would have been rejected at send time. This hasn't been verified live. They're now listed as "cannot be used here" with a reason:

| Template feature | Why it's blocked now |
|---|---|
| Named body variables (`{{first_name}}`, or `parameter_format` NAMED) | `main` counted 0 variables and sent no values |
| Text header with a variable | `main` never sent a header value |
| URL button with a variable | `main` never sent the button value |
| Copy-code button | needs a code at send time; `main` never sent one |
| Other button types (flow, one-time password, catalog and others) | not sent by `main` |
| Carousel, limited-time-offer and other unknown components | not sent by `main` |

Templates with only a TEXT header without variables, a `{{1}}`-style body, a footer, and quick-reply, phone or static URL buttons behave as before. Media headers were already hidden on `main`.

### Finding a template by name

If an approved template doesn't appear in the list, open New campaign, choose **Can't find your template? Enter its name**, and type its exact name and language code. The CRM asks Meta for that one template in the active number's Messaging account (`POST /api/templates/lookup`, which calls `GET /<WABA_ID>/message_templates?name=…&language=…`).

- **Matching:** only an exact name and language match counts, so near-matches from Meta's filter are ignored.
- **When it's found:** the template is saved like a synced one, and other templates are left untouched. If it can be used, it's selected. If not, the reason is shown.
- **Same checks as synced templates:** typed-in templates go through the same checks at launch and send: approval, supported shape, the image rules, and frozen content. Nothing is sent without that check.
