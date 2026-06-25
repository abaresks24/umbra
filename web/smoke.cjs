// Headless smoke test for the Umbra wallet: landing renders with the umbral disc,
// the Create flow reaches the home screen with disc + quick actions, no runtime
// errors. Prereqs: relayer (npm run web:server) + a server on :5173 (vite preview).
const puppeteer = require("puppeteer-core");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 412, height: 892, deviceScaleFactor: 2 });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(8000);
  const landing = await p.evaluate(() => ({ create: !!document.getElementById("go-create"), connect: !!document.getElementById("go-connect"), logo: !!document.querySelector(".hero-logo") }));
  await p.evaluate(() => document.getElementById("go-create").click());
  await sleep(500);
  await p.evaluate(() => { const c = document.getElementById("saved"); if (c) { c.checked = true; c.dispatchEvent(new Event("change")); } document.getElementById("open")?.click(); });
  await sleep(4000);
  const home = await p.evaluate(() => ({
    eclipse: !!document.querySelector(".hero-eclipse"),
    reveal: !!document.getElementById("reveal-bal"),
    send: !!document.querySelector('[data-sheet="send"]'),
    deposit: !!document.querySelector('[data-sheet="deposit"]'),
    audit: !!document.getElementById("go-audit"),
  }));
  await b.close();
  const pass = !errors.length && landing.create && landing.connect && landing.logo && home.eclipse && home.reveal && home.send && home.deposit && home.audit;
  console.log(pass ? "🎉 web smoke: PASS" : "❌ web smoke: FAIL", JSON.stringify({ landing, home }), errors.length ? "errors=" + errors.join("; ") : "");
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("smoke error:", e.message); process.exit(1); });
