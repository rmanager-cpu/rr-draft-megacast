// The show server. node:http only - no framework, nothing to install, nothing to
// build. The owner reads this code.
//
// It binds to loopback by default. The TVs are Chrome windows on this laptop's
// extended desktop, not devices on the venue network, so the venue Wi-Fi dropping
// cannot touch them and nothing is listening on a network anyone else can reach.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const BACKSLASH = String.fromCharCode(92); // written this way so no escape survives an edit
const PAGES = new Set(["board", "studio", "launch", "status", "curate"]);
const MAX_BODY = 64 * 1024;

export function createHttp({ webRoot = "web", routes = {}, onError = console.error }) {
  const root = resolve(webRoot);

  function serveStatic(res, relPath) {
    // Strip any leading separator so join() cannot be escaped, then confirm the
    // resolved path is still inside web/. Two checks, because one is a typo away.
    const rel = normalize(relPath).split(BACKSLASH).join("/").replace(/^[/]+/, "");
    const full = resolve(join(root, rel));
    if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) return notFound(res);
    res.writeHead(200, {
      "Content-Type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(full).pipe(res);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      if (path === "/") return redirect(res, "/status");
      if (path === "/favicon.ico") {
        // Chrome asks for this unprompted on every page. Answer it once rather
        // than leaving a 404 in the console that looks like a real fault.
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0a0d14"/><text x="8" y="12" font-size="11" font-family="sans-serif" fill="#ffd45e" text-anchor="middle">R</text></svg>');
      }

      // Named pages map to web/<name>.html
      const page = path.slice(1);
      if (PAGES.has(page)) return serveStatic(res, page + ".html");
      if (path.startsWith("/web/")) return serveStatic(res, path.slice(5));

      for (const [pattern, handler] of Object.entries(routes)) {
        const parts = pattern.split(" ");
        const raw = parts[0] === "RAW";
        const method = raw ? parts[1] : parts[0];
        const route = raw ? parts[2] : parts[1];
        if (req.method !== method) continue;
        const params = match(route, path);
        if (!params) continue;
        // A route declared RAW gets the request stream instead of a parsed body,
        // so a video file can be written straight to disk without being held in
        // memory or squeezed through the JSON size cap.
        if (raw) return await handler({ req, res, url, params, json: (c, o) => json(res, c, o) });
        const body = method === "POST" ? await readBody(req) : null;
        return await handler({ req, res, url, params, body, json: (c, o) => json(res, c, o), text: (c, t) => send(res, c, t) });
      }
      return notFound(res);
    } catch (e) {
      onError(e);
      if (!res.headersSent) json(res, 500, { error: e.message });
      else try { res.end(); } catch {}
    }
  });

  // The show must not die because one socket misbehaved.
  server.on("clientError", (_e, socket) => socket.destroy());

  return { server, serveStatic };
}

/** "/api/pick" or "/img/headshot/:id" against a real path. */
function match(route, path) {
  if (!route.includes(":")) return route === path ? {} : null;
  const r = route.split("/");
  const p = path.split("/");
  if (r.length !== p.length) return null;
  const params = {};
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith(":")) params[r[i].slice(1)] = decodeURIComponent(p[i]);
    else if (r[i] !== p[i]) return null;
  }
  return params;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function send(res, code, text) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

function notFound(res) {
  send(res, 404, "not found");
}
