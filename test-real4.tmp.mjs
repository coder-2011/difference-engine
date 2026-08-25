import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (err) => console.log("[pageerror]", err.message.slice(0, 500)));
page.on("response", async (res) => {
  if (res.url().includes("/api/diff-files/")) {
    let body = "";
    try { body = (await res.text()).slice(0, 120); } catch {}
    console.log("[diff-files]", res.status(), res.url().slice(0, 160), body);
  }
});
page.on("requestfailed", (req) => console.log("[reqfailed]", req.url().slice(0, 140), req.failure()?.errorText));

await page.goto("http://localhost:3123/microsoft/vscode/pull/331925", { waitUntil: "domcontentloaded" });
await page.waitForSelector("diffs-container", { timeout: 90000, state: "attached" });
await page.waitForTimeout(4000);

const rect = await page.evaluate(() => {
  const roots = [...document.querySelectorAll("diffs-container")].map((el) => el.shadowRoot).filter(Boolean);
  const buttons = roots.flatMap((root) => [...root.querySelectorAll("[data-expand-button]")]);
  const visible = buttons.find((b) => b.getBoundingClientRect().width > 0);
  return visible ? JSON.parse(JSON.stringify(visible.getBoundingClientRect())) : null;
});
if (!rect) { console.log("no button"); process.exit(1); }

console.log("CLICKING at", rect.x + rect.width / 2, rect.y + rect.height / 2);
await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
await page.waitForTimeout(5000);

const heights = await page.evaluate(() => {
  const roots = [...document.querySelectorAll("diffs-container")].map((el) => el.shadowRoot).filter(Boolean);
  return roots.map((root) => root.querySelector("pre")?.scrollHeight ?? 0);
});
console.log("SCROLL HEIGHTS AFTER:", heights);
await browser.close();
