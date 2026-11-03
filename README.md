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
src/lib/send.js         the one gate every outbound message passes through
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
