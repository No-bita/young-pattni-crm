import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";

test("a crashing screen shows Back and Reload, and Back returns to Inbox", async () => {
  const server = await createServer({
    root: new URL("../web", import.meta.url).pathname,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{ name: "local-test-crash", enforce: "pre", transform(source, id) {
      if (!id.endsWith("/src/App.jsx")) return;
      // Deliberate crash only in this local test, never in the application bundle.
      return source.replace("<Contacts />", "<LocalTestCrash />").replace("<Inbox contactId={id} />", 'id === "crash" ? <LocalTestCrash /> : <Inbox contactId={id} />') + '\nfunction LocalTestCrash() { throw new Error("Local test screen failure"); }';
    } }],
  });
  await server.listen();
  const executablePath = process.env.CHROME_EXECUTABLE || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    await page.route("**/api/**", async (route) => {
      const auth = new URL(route.request().url()).pathname === "/api/auth/me";
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(auth ? { account: { name: "Local test" } } : { conversations: [], total: 0, counts: {} }) });
    });
    const base = server.resolvedUrls.local[0];
    await page.goto(base + "#/inbox");
    await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Contacts" }).click();
    await page.getByRole("heading", { name: "Something went wrong" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Back", exact: true }).count(), 1);
    await page.screenshot({ path: process.env.ERROR_MOBILE_SCREENSHOT || "/tmp/pjm-error-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: process.env.ERROR_DESKTOP_SCREENSHOT || "/tmp/pjm-error-desktop.png", fullPage: true });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
    assert.ok(page.url().endsWith("#/inbox"));
    // A direct conversation link has no previous route; Back must still recover to Inbox.
    await page.goto(base + "#/inbox/crash");
    await page.reload();
    await page.getByRole("heading", { name: "Something went wrong" }).waitFor();
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Reload", exact: true }).click()]);
    await page.getByRole("heading", { name: "Something went wrong" }).waitFor();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
  } finally { await browser.close(); await server.close(); }
});
