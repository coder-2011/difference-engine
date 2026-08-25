import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (err) => console.log("[pageerror]", err.message.slice(0, 500)));

await page.goto("http://localhost:3123/microsoft/vscode/pull/331925", { waitUntil: "domcontentloaded" });
await page.waitForSelector("diffs-container", { timeout: 60000 });
await page.waitForTimeout(4000);

const info = () =>
  page.evaluate(() => {
    const roots = [...document.querySelectorAll("diffs-container")].map((el) => el.shadowRoot).filter(Boolean);
    const buttons = roots.flatMap((root) => [...root.querySelectorAll("[data-expand-button]")]);
    const visible = buttons.find((b) => b.getBoundingClientRect().width > 0);
    const pre = roots.map((root) => root.querySelector("pre"));
    return {
      containerCount: document.querySelectorAll("diffs-container").length,
      scrollHeights: pre.map((p) => p?.scrollHeight ?? 0),
      buttonCount: buttons.length,
      firstVisibleButton: visible
        ? {
            rect: JSON.parse(JSON.stringify(visible.getBoundingClientRect())),
            up: visible.hasAttribute("data-expand-up"),
            down: visible.hasAttribute("data-expand-down"),
            both: visible.hasAttribute("data-expand-both"),
          }
        : null,
    };
  });

const before = await info();
console.log("BEFORE:", JSON.stringify(before));

if (before.firstVisibleButton) {
  const { rect } = before.firstVisibleButton;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  // What element is actually at the click point (piercing shadow DOM)?
  const hit = await page.evaluate(({ cx, cy }) => {
    const element = document.elementFromPoint(cx, cy);
    const path = [];
    let node = element;
    while (node && path.length < 8) {
      path.push(node.tagName?.toLowerCase() + (node.getAttribute?.("data-expand-button") !== null && node.hasAttribute?.("data-expand-button") ? "[expand]" : "") + (node.hasAttribute?.("data-separator") ? "[sep]" : ""));
      node = node.shadowRoot ? null : node.parentElement ?? (node.getRootNode()?.host ?? null);
    }
    return { hitTag: element?.tagName, hitPath: path };
  }, { cx, cy });
  console.log("HIT TEST:", JSON.stringify(hit));

  await page.screenshot({ path: "/tmp/opencode/before.png", clip: { x: 0, y: Math.max(0, cy - 200), width: 1600, height: 400 } });
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(2500);

  const after = await info();
  console.log("AFTER:", JSON.stringify(after));
  await page.screenshot({ path: "/tmp/opencode/after.png", clip: { x: 0, y: Math.max(0, cy - 200), width: 1600, height: 400 } });
}

await browser.close();
