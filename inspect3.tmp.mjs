import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 400)));
page.on("pageerror", (err) => console.log("[pageerror]", err.message.slice(0, 800)));
page.on("requestfailed", (req) => console.log("[reqfailed]", req.url(), req.failure()?.errorText));

await page.addInitScript(() => {
  window.addEventListener("error", (e) => console.log("[window.error]", e.message));
  window.addEventListener("unhandledrejection", (e) => console.log("[unhandledrejection]", String(e.reason).slice(0, 400)));
});

await page.goto("http://127.0.0.1:3123/test-expand", { waitUntil: "networkidle" });
await page.waitForTimeout(5000);
await browser.close();
