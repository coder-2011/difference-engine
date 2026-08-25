import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

await page.goto("http://localhost:3123/test-expand", { waitUntil: "networkidle" });
await page.waitForSelector("diffs-container", { state: "attached" });
await page.waitForTimeout(2000);

const symbol = await page.evaluate(() => {
  const root = [...document.querySelectorAll("diffs-container")].map((el) => el.shadowRoot).find(Boolean);
  const button = [...(root?.querySelectorAll("[data-expand-button]") ?? [])].find((b) => b.getBoundingClientRect().width > 0);
  if (!button) return null;
  const style = getComputedStyle(button, "::before");
  const rect = button.getBoundingClientRect();
  return { content: style.content, fontSize: style.fontSize, rect: JSON.parse(JSON.stringify(rect)) };
});
console.log("SYMBOL:", JSON.stringify(symbol));

if (symbol?.rect) {
  await page.screenshot({ path: "/tmp/opencode/symbol.png", clip: { x: 0, y: Math.max(0, symbol.rect.y - 60), width: 800, height: 160 } });
}
await browser.close();
