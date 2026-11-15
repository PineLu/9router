/* Browser-level responsive smoke for the isolated production build.
 * Usage: npm run build && node tests/smoke/mobile-layout.cjs
 * Uses its own SQLite directory and port; never connects to production.
 */
const { chromium } = require("playwright-core");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const distDir = process.env.NEXT_DIST_DIR || ".next";
const serverDir = path.join(root, distDir, "standalone");
const baseUrl = "http://127.0.0.1:20129";
const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mobile-ui-"));
const password = "smoke-fixture-password";
const widths = [320, 360, 390, 430, 768, 1280];
const routes = [
  "/dashboard/endpoint",
  "/dashboard/providers",
  "/dashboard/combos",
  "/dashboard/usage?tab=details",
  "/dashboard/usage?tab=overview",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer(child) {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error("Isolated app exited before becoming ready");
    try {
      const result = await fetch(baseUrl + "/api/health", { signal: AbortSignal.timeout(2000) });
      if (result.ok) return;
    } catch {
      // Build server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Isolated app did not start");
}

async function main() {
  assert(fs.existsSync(path.join(serverDir, "custom-server.js")), "Run npm run build first");
  const server = spawn(process.execPath, ["custom-server.js", "--port", "20129"], {
    cwd: serverDir,
    env: {
      ...process.env,
      DATA_DIR: privateDir,
      HOME: privateDir,
      PORT: "20129",
      HOSTNAME: "127.0.0.1",
      INITIAL_PASSWORD: password,
      JWT_SECRET: "mobile-smoke-jwt-fixture",
      API_KEY_SECRET: "mobile-smoke-api-fixture",
      MACHINE_ID_SALT: "mobile-smoke-machine-fixture",
    },
    stdio: "ignore",
  });
  let browser;
  try {
    await waitForServer(server);
    browser = await chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });

    const login = await context.request.post(baseUrl + "/api/auth/login", {
      data: { password },
    });
    assert(login.ok(), "Isolated login failed: " + login.status());
    const page = await context.newPage();

    await page.route("**/api/usage/request-details?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          details: [{
            id: "mobile-fixture",
            timestamp: "2026-11-15T12:00:00.000Z",
            model: "mobile-test-model-with-a-long-name",
            comboName: "test-combo",
            provider: "openai",
            accountName: "fixture-account",
            status: "error",
            errorMessage: "Test failure message",
            tokens: { prompt_tokens: 1234, completion_tokens: 56 },
            latency: { ttft: 30, total: 420 },
          }],
          pagination: { page: 1, pageSize: 20, totalItems: 1 },
        }),
      });
    });

    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      for (const route of routes) {
        await page.goto(baseUrl + route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(400);
        const geometry = await page.evaluate(() => ({
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          contentWidth: document.querySelector("main")?.clientWidth || 0,
          bodyWidth: document.body.scrollWidth,
          viewportHeight: window.visualViewport?.height || window.innerHeight,
          rootHeight: document.querySelector("main")?.parentElement?.getBoundingClientRect().height || 0,
          bottomNavigation: (() => {
            const nav = document.querySelector('nav[aria-label="Quick navigation"]');
            if (!nav) return null;
            const bounds = nav.getBoundingClientRect();
            return { top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
          })(),
        }));
        assert(geometry.documentWidth <= width + 2,
          "Horizontal viewport overflow at " + width + "px " + route + ": " + JSON.stringify(geometry));
        assert(geometry.contentWidth > 0, "Missing content: " + route);
        const mobileNavigation = page.getByRole("navigation", { name: "Quick navigation" });
        assert(await mobileNavigation.isVisible() === (width < 1024),
          "Quick navigation breakpoint mismatch at " + width + "px " + route);
        if (width < 1024) {
          assert(Math.abs(geometry.rootHeight - geometry.viewportHeight) <= 2,
            "App shell does not match the visible viewport at " + width + "px " + route + ": " + JSON.stringify(geometry));
          assert(geometry.bottomNavigation && geometry.bottomNavigation.bottom <= geometry.viewportHeight + 2,
            "Bottom navigation is outside the visible viewport at " + width + "px " + route + ": " + JSON.stringify(geometry));
        }
        if (route === "/dashboard/endpoint" && width < 768) {
          const keyButtons = page.locator('button[aria-label="Show API key"], button[aria-label="Hide API key"], button[aria-label="Copy API key"]');
          for (let i = 0; i < await keyButtons.count(); i += 1) {
            const bounds = await keyButtons.nth(i).boundingBox();
            assert(bounds && bounds.width >= 44 && bounds.height >= 44,
              "API key action target is smaller than 44px at " + width + "px: " + JSON.stringify(bounds));
          }
        }
        if (route.includes("tab=overview") && width < 1024) {
          const controls = page.locator(".react-flow-controls-custom button");
          for (let i = 0; i < await controls.count(); i += 1) {
            const bounds = await controls.nth(i).boundingBox();
            assert(bounds && bounds.width >= 44 && bounds.height >= 44,
              "Topology control target is smaller than 44px at " + width + "px: " + JSON.stringify(bounds));
          }
        }
        if (route === "/dashboard/providers" && width < 768) {
          const mobileSearch = page.locator("header input:visible").first();
          await mobileSearch.waitFor();
          const searchBounds = await mobileSearch.boundingBox();
          assert(searchBounds && searchBounds.width >= width - 70,
            "Mobile header search too narrow at " + width + "px: " + JSON.stringify(searchBounds));
        }
        if (route.includes("tab=details")) {
          const mobileRecord = page.locator("article").filter({ hasText: "mobile-test-model-with-a-long-name" });
          if (width < 768) {
            assert(await mobileRecord.isVisible(), "Mobile detail card missing at " + width);
          } else {
            assert(!await mobileRecord.isVisible(), "Desktop did not hide mobile detail card at " + width);
          }
        }
        console.log("PASS", width + "px", route);
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl + "/dashboard/providers", { waitUntil: "domcontentloaded" });
    const menuButton = page.getByRole("button", { name: "Open navigation" });
    await menuButton.click();
    assert(await page.getByRole("dialog", { name: "Navigation" }).isVisible(), "Mobile menu did not open");
    await page.keyboard.press("Escape");
    assert(!await page.getByRole("dialog", { name: "Navigation" }).isVisible(), "Escape did not dismiss navigation");
    console.log("PASS mobile menu open/close");

    await page.getByRole("navigation", { name: "Quick navigation" })
      .getByRole("link", { name: "Usage" }).click();
    await page.waitForURL("**/dashboard/usage");
    console.log("PASS bottom navigation route change");

    await page.goto(baseUrl + "/dashboard/usage?tab=details", { waitUntil: "domcontentloaded" });
    const mobileDetailButton = page.locator("article").filter({ hasText: "mobile-test-model-with-a-long-name" })
      .getByRole("button", { name: "Detail" });
    await mobileDetailButton.click();
    const drawerBounds = await page.locator(".slide-in-right").boundingBox();
    assert(drawerBounds && drawerBounds.width <= 392 && drawerBounds.x >= -2,
      "Mobile request drawer exceeds phone viewport: " + JSON.stringify(drawerBounds));
    console.log("PASS full-width mobile request drawer");

    await page.goto(baseUrl + "/dashboard/endpoint", { waitUntil: "domcontentloaded" });
    const addKey = page.getByRole("button", { name: "Create Key" }).first();
    await addKey.waitFor();
    await addKey.click();
    const modal = page.getByRole("heading", { name: /Create|Add.*Key/i }).first();
    await modal.waitFor();
    const modalBounds = await modal.boundingBox();
    assert(modalBounds && modalBounds.y >= 0 && modalBounds.y < 844, "Create Key modal header outside viewport");
    console.log("PASS mobile modal open and visible");
    console.log("MOBILE_BROWSER_SMOKE=PASS");
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      if (server.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      server.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
    if (server.exitCode === null) server.kill("SIGKILL");
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
