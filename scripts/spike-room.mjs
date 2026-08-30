// Phase 0, Test B: what does the ESPN draft room actually emit? This is the
// raw material for the zero-operator pick source if Test A fails.
//
// Opens your real Chrome under Playwright control with a persistent profile
// (log in once; it sticks). Records every WebSocket frame on every page, logs
// draft-related XHR/fetch calls, and saves the draft room's visible text (and,
// less often, its HTML) whenever it changes. Nothing is clicked for you: log
// in if asked, open the Draft Room from the league page, then leave it alone.
// Output: spike/out/room.log, ws-frames.log, dom-*.txt / dom-*.html
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  page.on("response", async (r) => {
    const t = r.request().resourceType();
    const u = r.url();
    if (/googlesyndication|doubleclick|google\.com|parsely|bamgrid|pagead|onefeed/i.test(u)) return;
    if ((t === "xhr" || t === "fetch") && /draft|pick|league|player/i.test(u))
      log("page " + n + " " + t + " " + r.status() + " " + u.slice(0, 220));
    // Writes to ESPN (settings saves, draft actions): keep the request body and
    // the response so we can see exactly what ESPN accepted.
    if (/lm-api-writes|fantasy\.espn\.com\/apis\/v3\/.*\/(draft|settings)/i.test(u) && r.request().method() !== "GET") {
      let body = "";
      try { body = (await r.text()).slice(0, 4000); } catch {}
      appendFileSync(out + "/writes.log", ts() + " " + r.request().method() + " " + r.status() + " " + u + "\nREQUEST " + (r.request().postData() || "").slice(0, 4000) + "\nRESPONSE " + body + "\n\n");
      log("page " + n + " WRITE " + r.request().method() + " " + r.status() + " " + u.slice(0, 160) + " (body in writes.log)");
    }
  });
  page.on("dialog", (d) => {
    log("page " + n + " DIALOG " + d.type() + ": " + d.message());
    d.accept().catch(() => {});
  });
  page.on("close", () => log("page " + n + " closed"));
  // Red banner so this window is unmistakable next to the owner's own Chrome.
  const banner = () =>
    page
      .evaluate(() => {
        if (document.getElementById("rr-recorder-banner")) return;
        const d = document.createElement("div");
        d.id = "rr-recorder-banner";
        d.textContent = "RECORDER WINDOW  -  log in and open the Draft Room here, then leave it alone";
        d.setAttribute(
          "style",
          "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c3372b;color:#fff;font:700 15px system-ui,sans-serif;padding:6px 12px;text-align:center;pointer-events:none",
        );
        document.documentElement.appendChild(d);
      })
      .catch(() => {});
  page.on("load", banner);
  page.on("domcontentloaded", banner);

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

// Cookie hand-off: once you log in in this window, SWID + espn_s2 are written
// to .env so the poller (and later the watcher) can use them. Values are
// never logged.
let lastSync = "";
async function syncCookies() {
  try {
    const cookies = await ctx.cookies("https://fantasy.espn.com");
    const swid = cookies.find((c) => c.name === "SWID")?.value;
    const s2 = cookies.find((c) => c.name === "espn_s2")?.value;
    if (!swid || !s2) return;
    const sig = swid + "|" + s2;
    if (sig === lastSync) return;
    lastSync = sig;
    const lines = existsSync(".env") ? readFileSync(".env", "utf8").split(/\r?\n/).filter((l, i, a) => l !== "" || i < a.length - 1) : [];
    const set = (key, val) => {
      const i = lines.findIndex((l) => l.startsWith(key + "="));
      if (i >= 0) lines[i] = key + "=" + val;
      else lines.push(key + "=" + val);
    };
    set("ESPN_SWID", swid);
    set("ESPN_S2", s2);
    writeFileSync(".env", lines.join("\n").replace(/\n*$/, "") + "\n");
    log("ESPN cookies synced to .env");
  } catch (e) {
    log("cookie sync failed: " + e.message);
  }
}
setInterval(syncCookies, 3000);

process.on("SIGINT", async () => {
  log("stopping");
  await ctx.close().catch(() => {});
  process.exit(0);
});
