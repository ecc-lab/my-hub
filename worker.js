// ════════════════════════════════════════════════════════════════
//  my-hub Worker — handles /api/* requests, falls through to static
// ════════════════════════════════════════════════════════════════
//
//  GET  /api/data/:key   → reads JSON from DATA_KV
//  POST /api/data/:key   → writes JSON to DATA_KV
//  POST /api/coach       → proxies Anthropic API (key stays server-side)
//  GET  /api/ping        → health check
//  Anything else         → served from static assets (ASSETS binding)
//
//  Required bindings (configure in Cloudflare Dashboard):
//    - DATA_KV          (KV namespace)
//    - ASSETS           (set automatically from wrangler.jsonc)
//    - ANTHROPIC_KEY    (secret — Settings → Variables → encrypt)

const MAX_BYTES = 1_000_000;

// ── Allowed KV keys (whitelist) ──
const ALLOWED_KEYS = new Set([
  "strategic-hub",
  "gymlog:default",
  "gymlog:ec_v3",
  "finance:default",
]);

// ── Security headers applied to ALL responses ──
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.sheetjs.com https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "connect-src 'self'; " +
    "img-src 'self' data:; " +
    "frame-ancestors 'none';",
};

const JSON_CT = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate",
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_CT, ...SECURITY_HEADERS },
  });
}

function addSecurityHeaders(response) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    r.headers.set(k, v);
  }
  return r;
}

// ── Rate limiter (simple per-IP, stored in-memory per isolate) ──
const rateLimits = new Map();
const RATE_WINDOW = 60_000; // 1 minute
const RATE_MAX = 120;       // max requests per window

function checkRateLimit(ip) {
  const now = Date.now();
  // Inline cleanup of expired entries (Workers are stateless, setInterval won't work)
  for (const [k, v] of rateLimits) {
    if (now - v.start > RATE_WINDOW) rateLimits.delete(k);
  }
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_MAX) return false;
  return true;
}

// ── /api/data/:key handler ──
async function handleData(request, env, key) {
  if (!env.DATA_KV) {
    return jsonResponse({ error: "service unavailable" }, 503);
  }

  if (!ALLOWED_KEYS.has(key)) {
    return jsonResponse({ error: "not found" }, 404);
  }

  if (request.method === "GET") {
    const value = await env.DATA_KV.get(key);
    // Wrap raw data with version metadata for conflict detection
    const meta = await env.DATA_KV.get(key + ":meta");
    const version = meta ? JSON.parse(meta) : null;
    const resp = new Response(value ?? "null", {
      headers: { ...JSON_CT, ...SECURITY_HEADERS },
    });
    if (version) {
      resp.headers.set("etag", '"' + version.v + '"');
      resp.headers.set("x-data-version", String(version.v));
      resp.headers.set("x-data-ts", String(version.ts));
    }
    return resp;
  }

  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.text();
    if (body.length > MAX_BYTES) {
      return jsonResponse({ error: "payload too large" }, 413);
    }
    try {
      JSON.parse(body);
    } catch {
      return jsonResponse({ error: "bad request" }, 400);
    }

    // Version conflict detection via If-Match header
    const ifMatch = request.headers.get("if-match");
    if (ifMatch) {
      const meta = await env.DATA_KV.get(key + ":meta");
      const current = meta ? JSON.parse(meta) : null;
      const clientV = parseInt(ifMatch.replace(/"/g, ""), 10);
      if (current && !isNaN(clientV) && clientV < current.v) {
        return jsonResponse({ error: "conflict", server_version: current.v, your_version: clientV }, 409);
      }
    }

    // Bump version
    const metaRaw = await env.DATA_KV.get(key + ":meta");
    const prev = metaRaw ? JSON.parse(metaRaw) : { v: 0, ts: 0 };
    const newVersion = { v: prev.v + 1, ts: Date.now() };
    await env.DATA_KV.put(key, body);
    await env.DATA_KV.put(key + ":meta", JSON.stringify(newVersion));
    return jsonResponse({ ok: true, size: body.length, version: newVersion.v });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        allow: "GET, POST, PUT, OPTIONS",
        ...SECURITY_HEADERS,
        "cache-control": "no-store",
      },
    });
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}

// ── /api/coach handler (Anthropic proxy) ──
async function handleCoach(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const apiKey = env.ANTHROPIC_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "service unavailable" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }

  // Only allow messages endpoint with constrained params
  const payload = {
    model: body.model || "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: body.system || "",
    messages: body.messages || [],
  };

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const result = await resp.text();
    return new Response(result, {
      status: resp.status,
      headers: { ...JSON_CT, ...SECURITY_HEADERS },
    });
  } catch {
    return jsonResponse({ error: "upstream error" }, 502);
  }
}

// ── Main fetch handler ──
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";

    // Rate limit all /api/* requests
    if (url.pathname.startsWith("/api/")) {
      if (!checkRateLimit(ip)) {
        return jsonResponse({ error: "too many requests" }, 429);
      }
    }

    // /api/data/:key
    const dataMatch = url.pathname.match(/^\/api\/data\/(.+)$/);
    if (dataMatch) {
      const key = decodeURIComponent(dataMatch[1]);
      if (!/^[a-zA-Z0-9:_-]+$/.test(key)) {
        return jsonResponse({ error: "invalid key format" }, 400);
      }
      return handleData(request, env, key);
    }

    // /api/coach (Anthropic proxy)
    if (url.pathname === "/api/coach") {
      return handleCoach(request, env);
    }

    // /api/ping
    if (url.pathname === "/api/ping") {
      return jsonResponse({
        ok: true,
        ts: Date.now(),
        kv_bound: !!env.DATA_KV,
      });
    }

    // Static assets with security headers
    const assetResponse = await env.ASSETS.fetch(request);
    return addSecurityHeaders(assetResponse);
  },
};
