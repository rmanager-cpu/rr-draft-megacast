// Phase 0, Test B: what does the ESPN draft room actually emit? This is the
// raw material for the zero-operator pick source if Test A fails.
//
// Opens your real Chrome under Playwright control with a persistent profile
// (log in once; it sticks). Records every WebSocket frame on every page, logs
// draft-related XHR/fetch calls, and saves the draft room's visible text (and,
// less often, its HTML) whenever it changes. Nothing is clicked for you: log
// in if asked, open the Draft Room from the league page, then leave it alone.
// Output: spike/out/room.log, ws-frames.log, dom-*.txt / dom-*.html
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { loadEnv, requireLeague } from "./env.mjs";

const env = loadEnv();
const { id, season } = requireLeague(env);
const out = "spike/out";
mkdirSync(out, { recursive: true });
const ts = () => new Date().toISOString();
const log = (line) => {
  const s = ts() + " " + line;
  console.log(s);
  appendFileSync(out + "/room.log", s + "\n");
};
const frame = (line) => appendFileSync(out + "/ws-frames.log", ts() + " " + line + "\n");
const MAX = 200000;
const payload = (p) => {
  if (typeof p === "string") return p.length > MAX ? p.slice(0, MAX) + " ...[+" + (p.length - MAX) + " chars]" : p;
  return "<binary " + p.length + "B b64:" + p.toString("base64").slice(0, 4000) + ">";
};

const ctx = await chromium.launchPersistentContext("spike/chrome-profile", {
  channel: "chrome",
  headless: false,
  viewport: null,
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--start-maximized"],
});

let pageN = 0;
function watch(page) {
  const n = ++pageN;
  log("page " + n + " opened " + page.url());
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) log("page " + n + " -> " + f.url());
  });
  page.on("websocket", (ws) => {
    log("page " + n + " WS open " + ws.url());
    ws.on("framereceived", (f) => frame("p" + n + " RECV " + payload(f.payload)));
    ws.on("framesent", (f) => frame("p" + n + " SENT " + payload(f.payload)));
    ws.on("close", () => log("page " + n + " WS closed " + ws.url()));
    ws.on("socketerror", (e) => log("page " + n + " WS error " + e));
  });
  page.on("response", (r) => {
    const t = r.request().resourceType();
    if ((t === "xhr" || t === "fetch") && /draft|pick|league|player/i.test(r.url()))
      log("page " + n + " " + t + " " + r.status() + " " + r.url().slice(0, 220));
  });
  page.on("dialog", (d) => {
    log("page " + n + " DIALOG " + d.type() + ": " + d.message());
    d.accept().catch(() => {});
  });
  page.on("close", () => log("page " + n + " closed"));

  let lastLen = -1;
  let lastHtmlAt = 0;
  const timer = setInterval(async () => {
    if (page.isClosed()) return clearInterval(timer);
    if (!/draft/i.test(page.url())) return;
    try {
      const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
      if (text.length === lastLen) return;
      lastLen = text.length;
      const stamp = ts().replace(/[:.]/g, "-");
      writeFileSync(out + "/dom-p" + n + "-" + stamp + ".txt", text);
      if (Date.now() - lastHtmlAt > 60000) {
        lastHtmlAt = Date.now();
        writeFileSync(out + "/dom-p" + n + "-" + stamp + ".html", await page.content());
      }
      log("page " + n + " snapshot " + text.length + " chars");
    } catch (e) {
      log("page " + n + " snapshot failed: " + e.message);
    }
  }, 10000);
}

ctx.pages().forEach(watch);
ctx.on("page", watch);
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://fantasy.espn.com/football/league?leagueId=" + id + "&seasonId=" + season);
log("Log in if asked. Open the Draft Room from the league page when it is available. Then leave the window alone. Ctrl+C here after the draft completes.");

process.on("SIGINT", async () => {
  log("stopping");
  await ctx.close().catch(() => {});
  process.exit(0);
});
