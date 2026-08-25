import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto("http://localhost:3123/test-expand", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const snapshot = async () =>
  page.evaluate(() => {
    const root = document.querySelector("diffs-container")?.shadowRoot;
    if (!root) return { error: "no shadow root" };
    const separators = [...root.querySelectorAll("[data-separator='line-info']")];
    const buttons = [...root.querySelectorAll("[data-expand-button]")];
    const lines = root.querySelectorAll("[data-line]").length;
    return {
      lineCount: lines,
      separators: separators.map((s) => ({
        text: s.querySelector("[data-unmodified-lines]")?.textContent ?? null,
        expandIndex: s.getAttribute("data-expand-index"),
        rect: JSON.parse(JSON.stringify(s.getBoundingClientRect())),
      })),
      buttons: buttons.map((b) => ({
        up: b.hasAttribute("data-expand-up"),
        down: b.hasAttribute("data-expand-down"),
        both: b.hasAttribute("data-expand-both"),
        rect: JSON.parse(JSON.stringify(b.getBoundingClientRect())),
      })),
    };
  });

console.log("BEFORE:", JSON.stringify(await snapshot(), null, 2));

// Click the middle separator's expand button with a real mouse click.
const state = await snapshot();
const target = state.buttons?.[0]?.rect ?? state.separators?.[1]?.rect;
if (!target || !target.width) {
  console.log("No clickable expander found");
} else {
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await page.waitForTimeout(1200);
  console.log("AFTER:", JSON.stringify(await snapshot(), null, 2));
}

await browser.close();
