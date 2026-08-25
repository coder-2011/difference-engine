import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (msg) => {
  const text = msg.text();
  if (!text.includes("WebSocket") && !text.includes("Download the React DevTools")) console.log("[console]", msg.type(), text.slice(0, 300));
});
page.on("pageerror", (err) => console.log("[pageerror]", err.message.slice(0, 500)));

await page.goto("http://localhost:3123/microsoft/vscode/pull/331925", { waitUntil: "domcontentloaded" });
await page.waitForSelector("diffs-container", { timeout: 60000 });
await page.waitForTimeout(4000);

const snapshot = () =>
  page.evaluate(() => {
    const roots = [...document.querySelectorAll("diffs-container")].map((el) => el.shadowRoot).filter(Boolean);
    const separators = roots.flatMap((root) => [...root.querySelectorAll("[data-separator='line-info']")]);
    const buttons = roots.flatMap((root) => [...root.querySelectorAll("[data-expand-button]")]);
    return {
      containers: document.querySelectorAll("diffs-container").length,
      lineCount: roots.reduce((total, root) => total + root.querySelectorAll("[data-line]").length, 0),
      separators: separators.slice(0, 6).map((s) => ({
        text: s.querySelector("[data-unmodified-lines]")?.textContent ?? null,
        expandIndex: s.getAttribute("data-expand-index"),
      })),
      totalSeparators: separators.length,
      buttonCount: buttons.length,
      firstButtonRect: (() => {
        const visible = buttons.find((b) => b.getBoundingClientRect().width > 0);
        if (!visible) return null;
        return JSON.parse(JSON.stringify(visible.getBoundingClientRect()));
      })(),
    };
  });

const before = await snapshot();
console.log("BEFORE:", JSON.stringify(before, null, 2));

if (before.firstButtonRect) {
  const rect = before.firstButtonRect;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.waitForTimeout(2500);
  const after = await snapshot();
  console.log("AFTER:", JSON.stringify({ ...after, firstButtonRect: undefined }, null, 2));
} else {
  console.log("NO VISIBLE EXPAND BUTTON");
}

await page.screenshot({ path: "/tmp/opencode/real-app.png" });
await browser.close();
