import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (err) => console.log("[pageerror]", err.message.slice(0, 400)));
page.on("response", async (res) => {
  if (res.url().includes("/api/diff-files/")) console.log("[diff-files]", res.status(), res.url().slice(90, 150));
});

await page.goto("http://localhost:3123/microsoft/vscode/pull/331925", { waitUntil: "domcontentloaded" });
await page.waitForSelector("diffs-container", { timeout: 90000, state: "attached" });
await page.waitForTimeout(5000);

const state = () =>
  page.evaluate(() => {
    const roots = [...document.querySelectorAll("diffs-container")].map((el) => el.shadowRoot).filter(Boolean);
    const buttons = roots.flatMap((root) => [...root.querySelectorAll("[data-expand-button]")]);
    const visible = buttons.find((b) => b.getBoundingClientRect().width > 0);
    const style = visible ? getComputedStyle(visible, "::before") : null;
    return {
      heights: roots.map((root) => root.querySelector("pre")?.scrollHeight ?? 0),
      buttonRect: visible ? JSON.parse(JSON.stringify(visible.getBoundingClientRect())) : null,
      symbolFontSize: style?.fontSize,
      symbolContent: style?.content,
    };
  });

const before = await state();
console.log("BEFORE:", JSON.stringify(before));

// Click the same button twice to prove repeated expansion works.
for (let round = 1; round <= 2; round++) {
  const { buttonRect } = await state();
  if (!buttonRect) { console.log(`round ${round}: no visible button`); break; }
  await page.mouse.click(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2);
  await page.waitForTimeout(3500);
  const after = await state();
  console.log(`ROUND ${round} AFTER:`, JSON.stringify({ heights: after.heights, symbolFontSize: after.symbolFontSize, symbolContent: after.symbolContent }));
}

await page.screenshot({ path: "/tmp/opencode/final.png" });
await browser.close();
