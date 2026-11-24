// Real browser smoke test with local API fixtures. No live CRM access or messages.
// Run: CHROME_EXECUTABLE=/usr/bin/google-chrome node --test tests/inbox-browser.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";

test("Inbox contact opens and refreshes without a render error; pagination stays in the list", async () => {
  const server = await createServer({ root: new URL("../web", import.meta.url).pathname, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const executablePath = process.env.CHROME_EXECUTABLE || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error("Browser error:", error.message); });
    const contact = { id: "test-contact", name: "Test Contact", phone: "+919800000001", windowOpen: true, suppressed: false };
    let mode = "normal";
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = path === "/api/auth/me" ? { account: { name: "Local test", isAdmin: false } }
        : path === "/api/inbox/test-contact" ? { contact, messages: mode === "empty" ? [] : [{ id: "m1", direction: "inbound", body: "Hello from contact", status: "received", createdAt: "2026-11-24T06:00:00Z" }] }
        : { conversations: [{ ...contact, contactId: contact.id, lastBody: "Hello from contact", lastDirection: "inbound", lastMessageAt: "2026-11-24T06:00:00Z" }], total: 1, counts: { all: 1, replied: 1 } };
      await route.fulfill({ status: path === "/api/inbox/test-contact" && mode === "error" ? 500 : 200, contentType: "application/json", body: JSON.stringify(mode === "error" && path === "/api/inbox/test-contact" ? { error: "Local test load error" } : data) });
    });
    await page.goto(server.resolvedUrls.local[0] + "#/inbox");
    await page.getByRole("link").filter({ hasText: "Test Contact" }).click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 5000 });
    assert.deepEqual(errors, []);
    assert.equal(await page.getByRole("button", { name: "Previous", exact: true }).count(), 0);
    await page.screenshot({ path: process.env.INBOX_SCREENSHOT || "/tmp/pjm-inbox-fixed-mobile.png", fullPage: true });
    await page.reload();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    mode = "empty";
    await page.reload();
    await page.getByText("No messages yet.").waitFor();
    mode = "error";
    await page.reload();
    await page.getByText("Local test load error").waitFor();
    mode = "normal";
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    await page.getByRole("link", { name: "← Back to inbox" }).click();
    await page.getByRole("button", { name: "Previous", exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
