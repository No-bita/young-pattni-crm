import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";

test("draft audience recovery works with empty, stale and opted-out selections on phone and desktop", async () => {
  const server = await createServer({ root: new URL("../web", import.meta.url).pathname, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const executablePath = process.env.CHROME_EXECUTABLE || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    let scenario = "empty", saved = false, launches = 0, previewEmpty = false;
    const audience = () => saved ? { chosen: true, selected: 1, suppressed: 0, sendable: 1 } : { chosen: true, selected: scenario === "suppressed" ? 1 : 0, suppressed: scenario === "suppressed" ? 1 : 0, sendable: 0 };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let data;
      if (path === "/api/auth/me") data = { account: { name: "Local test" } };
      else if (path === "/api/contacts/imports") data = { imports: [] };
      else if (path === "/api/contacts") data = { contacts: [{ id: "eligible", name: "Eligible contact", phone: "+919800000001", suppressed: false }], total: 1 };
      else if (path.endsWith("/audience")) { saved = true; data = {}; }
      else if (path.endsWith("/launch")) { launches++; data = {}; }
      else if (path.endsWith("/preview")) data = { audience: previewEmpty ? { chosen: true, selected: 0, suppressed: 0, sendable: 0 } : audience(), blocker: saved && !previewEmpty ? null : { code: "AUDIENCE_EMPTY", message: scenario === "suppressed" ? "Every selected contact has opted out." : "Choose the audience first. An empty audience never means everyone." } };
      else data = {
        campaign: { id: "draft", name: "Test campaign", status: "draft", audience: audience(), templateName: "test_message", templateLanguage: "en", params: [], content: { body: { text: "A long campaign message. ".repeat(100) } } },
        template: { bodyText: "A long campaign message. ".repeat(100) },
        audienceIds: saved ? ["eligible"] : scenario === "stale" ? ["missing-contact"] : scenario === "suppressed" ? ["opted-out-contact"] : [],
      };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    const base = server.resolvedUrls.local[0];
    if (process.env.CAMPAIGN_BEFORE_SCREENSHOT) {
      await page.goto(base + "#/campaigns/draft/review");
      await page.getByRole("heading", { name: "Review and send" }).waitFor();
      await page.screenshot({ path: process.env.CAMPAIGN_BEFORE_SCREENSHOT });
      assert.equal(await page.getByRole("button", { name: "Change audience" }).count(), 0);
      return;
    }
    for (const width of [420, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (scenario of ["empty", "stale", "suppressed"]) {
        saved = false;
        await page.goto(base + "#/campaigns/draft/review");
        await page.reload();
        await page.getByRole("heading", { name: "Who receives it" }).waitFor();
        await page.getByRole("alert").filter({ hasText: /Choose at least one contact|opted out/ }).waitFor({timeout:3000}).catch(async e => { console.log({width, scenario, body:await page.locator("body").innerText()}); throw e; });
        assert.equal(launches, 0);
        assert.equal(await page.getByRole("button", { name: "Send to 0 contacts" }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Review campaign" }).isDisabled(), true);
        // Stale and opted-out saved IDs must not count as eligible selections.
        await page.getByRole("checkbox", { name: "Select Eligible contact" }).check();
        await page.getByRole("button", { name: "Review campaign" }).click();
        await page.getByRole("heading", { name: "Review and send" }).waitFor();
        const change = page.getByRole("button", { name: "Change audience", exact: true });
        assert.equal(await change.count(), 1);
        assert.ok((await change.boundingBox()).y < 900);
        assert.equal(await page.getByRole("button", { name: "Send to 1 contacts" }).isDisabled(), true);
        // While the draft is open, the last eligible contact can become unavailable.
        saved = false;
        await page.reload();
        await page.getByRole("heading", { name: "Who receives it" }).waitFor();
        if (width === 420 && scenario === "empty" && process.env.CAMPAIGN_AFTER_SCREENSHOT) await page.screenshot({ path: process.env.CAMPAIGN_AFTER_SCREENSHOT });
      }
    }
    // A preview-time blocker must not trap a review that was opened with a valid audience.
    for (const width of [420, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      saved = true; previewEmpty = true;
      await page.goto(base + "#/campaigns/draft/review");
      await page.reload();
      await page.getByRole("button", { name: "Choose contacts", exact: true }).waitFor();
      const alert = await page.getByRole("alert").boundingBox();
      const preview = await page.getByText("Message preview · test_message (en)").boundingBox();
      assert.ok(alert.y < preview.y && alert.y < 900);
      assert.equal(await page.getByRole("button", { name: "Change audience", exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: /^Send to/ }).count(), 0);
      await page.getByRole("button", { name: "Choose contacts", exact: true }).click();
      await page.getByRole("heading", { name: "Who receives it" }).waitFor();
    }
    assert.deepEqual(errors, []);
    assert.equal(launches, 0);
  } finally { await browser.close(); await server.close(); }
});
