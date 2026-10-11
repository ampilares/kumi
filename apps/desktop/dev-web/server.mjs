/**
 * Kumi web dev mode: run the real renderer in a BROWSER against the real
 * SQLite workspace — no Electron, no reinstalling, instant Vite HMR.
 *
 *   pnpm --filter @kumi/desktop dev:web        (or `pnpm dev:web` at the root)
 *
 * This process does two things:
 *  1. Serves @kumi/core's command surface over HTTP on port 8484:
 *       POST /invoke        {method, args}  -> {ok, value} | {ok:false, error}
 *       GET  /events        SSE stream of {method} after mutating invokes
 *       GET  /asset/<id>    asset bytes with the stored MIME
 *       POST /url-meta      {url} -> {url, title, description, favicon}
 *       GET  /status        {ready, path, error}
 *  2. Spawns Vite (vite.web.config.ts) which serves the renderer at
 *     http://localhost:5183 and proxies /kumi-dev/* to this server.
 *
 * The workspace is the same one the app uses (%USERPROFILE%\Kumi), so what you
 * see in the browser is your real data — override with KUMI_WORKSPACE for a
 * scratch workspace. WAL mode makes concurrent use with the app/CLI safe.
 *
 * Not available in the browser (Electron-only, shimmed to graceful no-ops):
 * OS file dialogs, drag-drop file import, PDF export, show-in-folder.
 */
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const core = require(resolve(here, "../../../packages/core/dist/index.js"));

const PORT = 8484;
const workspacePath = process.env.KUMI_WORKSPACE ?? join(homedir(), "Kumi");
const { commands } = core.openWorkspace(workspacePath);

/** Read-only command prefixes; everything else broadcasts a changed event. */
const READ_PREFIXES = ["get", "list", "search", "query", "plan", "assetAbsolutePath"];
const isRead = (method) => READ_PREFIXES.some((p) => method.startsWith(p));

/** @type {Set<import("node:http").ServerResponse>} */
const sseClients = new Set();
function broadcast(method) {
  const frame = `data: ${JSON.stringify({ method })}\n\n`;
  for (const res of sseClients) res.write(frame);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function fetchUrlMeta(url) {
  const empty = { url, title: null, description: null, favicon: null };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    const html = (await response.text()).slice(0, 200_000);
    const pick = (re) => {
      const m = html.match(re);
      return m ? m[1].trim().replace(/\s+/g, " ") : null;
    };
    const title = pick(/<title[^>]*>([^<]*)<\/title>/i);
    const description =
      pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ??
      pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
    const iconHref = pick(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']*)["']/i);
    const favicon = iconHref ? new URL(iconHref, response.url).toString() : null;
    return { url, title, description, favicon };
  } catch {
    return empty;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    // Vite strips the /kumi-dev prefix via its proxy `rewrite`; accept both.
    const path = url.pathname.replace(/^\/kumi-dev/, "") || "/";

    if (req.method === "POST" && path === "/invoke") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "invalid JSON" } });
      }
      const { method, args } = payload ?? {};
      const fn = typeof method === "string" ? commands[method] : undefined;
      if (typeof fn !== "function") {
        return json(res, 200, { ok: false, error: { code: "UNKNOWN_METHOD", message: String(method) } });
      }
      try {
        const value = fn.apply(commands, Array.isArray(args) ? args : []);
        if (!isRead(method)) broadcast(method);
        return json(res, 200, { ok: true, value: value ?? null });
      } catch (err) {
        const code = typeof err?.code === "string" ? err.code : "COMMAND_FAILED";
        return json(res, 200, { ok: false, error: { code, message: String(err?.message ?? err) } });
      }
    }

    if (path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(":\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (path.startsWith("/asset/")) {
      const id = decodeURIComponent(path.slice("/asset/".length));
      try {
        const absolute = commands.assetAbsolutePath(id);
        const asset = commands.getAsset(id);
        const size = statSync(absolute).size;
        res.writeHead(200, {
          "Content-Type": asset?.mime || "application/octet-stream",
          "Content-Length": size,
          "Cache-Control": "no-cache",
        });
        createReadStream(absolute).pipe(res);
      } catch {
        json(res, 404, { ok: false, error: { code: "not_found", message: id } });
      }
      return;
    }

    if (req.method === "POST" && path === "/url-meta") {
      const { url: target } = JSON.parse(await readBody(req));
      return json(res, 200, await fetchUrlMeta(String(target)));
    }

    if (path === "/status") {
      return json(res, 200, { ready: true, path: workspacePath, error: null });
    }

    json(res, 404, { ok: false, error: { code: "not_found", message: path } });
  })().catch((err) => {
    json(res, 500, { ok: false, error: { code: "internal", message: String(err) } });
  });
});

server.listen(PORT, () => {
  console.log(`[kumi web-dev] command server on http://localhost:${PORT}`);
  console.log(`[kumi web-dev] workspace: ${workspacePath}`);
  const vite = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "vite", "--config", "vite.web.config.ts"],
    { cwd: resolve(here, ".."), stdio: "inherit", shell: process.platform === "win32" },
  );
  vite.on("exit", (code) => {
    server.close();
    process.exit(code ?? 0);
  });
});
