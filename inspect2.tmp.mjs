import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 300)));
page.on("pageerror", (err) => console.log("[pageerror]", err.message.slice(0, 500)));

await page.goto("http://localhost:3123/test-expand", { waitUntil: "networkidle" });
await page.waitForTimeout(4000);

console.log(await page.evaluate(() => ({
  tag: Boolean(customElements.get("diffs-container")),
  containers: document.querySelectorAll("diffs-container").length,
  html: document.querySelector("main > div:last-of-type")?.innerHTML?.slice(0, 400),
})));

await browser.close();
