import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto("http://127.0.0.1:3123/test-expand", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

console.log(await page.evaluate(() => {
  const walk = (node, depth) => {
    if (depth > 4 || !node) return [];
    const out = [];
    for (const child of node.children ?? []) {
      out.push(`${"  ".repeat(depth)}<${child.tagName.toLowerCase()}> shadow=${child.shadowRoot != null} attrs=${[...child.attributes].map((a) => a.name).join(",")}`);
      out.push(...walk(child.shadowRoot ?? child, depth + 1));
    }
    return out;
  };
  return walk(document.body, 0).join("\n");
}));

await browser.close();
