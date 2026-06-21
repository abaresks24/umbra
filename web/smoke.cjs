// Headless smoke test: load the built web wallet and assert it renders with no
// runtime errors and the action buttons are present. Catches browser-only
// regressions (e.g. a stray CommonJS `require` surviving into the bundle).
// Prereqs: relayer (npm run web:server) + a server on :5173 (vite preview).
const puppeteer = require("puppeteer-core");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 45000 });
  await new Promise((r) => setTimeout(r, 8000));
  const ok = await page.evaluate(() => ({
    rendered: (document.getElementById("app")?.innerHTML?.length || 0) > 200,
    shield: !!document.getElementById("b-shield"),
    send: !!document.getElementById("b-send"),
    audit: !!document.getElementById("b-audit"),
  }));
  await browser.close();
  const pass = errors.length === 0 && ok.rendered && ok.shield && ok.send && ok.audit;
  console.log(pass ? "🎉 web smoke: PASS" : "❌ web smoke: FAIL", JSON.stringify(ok), errors.length ? "errors=" + errors.join("; ") : "");
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("smoke error:", e.message); process.exit(1); });
