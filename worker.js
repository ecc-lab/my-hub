// ════════════════════════════════════════════════════════════════
//  my-hub Worker — handles /api/* requests, falls through to static
// ════════════════════════════════════════════════════════════════
//
//  GET  /api/data/:key  → reads JSON from DATA_KV
//  POST /api/data/:key  → writes JSON to DATA_KV
//  Anything else        → served from static assets (ASSETS binding)
//
//  Required bindings (configure in Cloudflare Dashboard):
//    - DATA_KV    (KV namespace)
//    - ASSETS     (set automatically from wrangler.jsonc)

const MAX_BYTES = 1_000_000; // 1 MB safety cap on each KV value

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate",
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: jsonHeaders });
}

async function handleData(request, env, key) {
  if (!env.DATA_KV) {
    return jsonResponse(
      { error: "KV binding DATA_KV not configured on this Worker" },
      500
    );
  }

  if (request.method === "GET") {
    const value = await env.DATA_KV.get(key);
    return new Response(value ?? "null", { headers: jsonHeaders });
  }

  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.text();
    if (body.length > MAX_BYTES) {
      return jsonResponse({ error: "payload too large", limit: MAX_BYTES }, 413);
    }
    try {
      JSON.parse(body);
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    await env.DATA_KV.put(key, body);
    return jsonResponse({ ok: true, key, size: body.length });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: { allow: "GET, POST, PUT, OPTIONS", "cache-control": "no-store" },
    });
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Match /api/data/:key  (key may contain colons, hyphens, etc.)
    const match = url.pathname.match(/^\/api\/data\/(.+)$/);
    if (match) {
      const key = decodeURIComponent(match[1]);
      return handleData(request, env, key);
    }

    // Health check for debugging the Worker is running
    if (url.pathname === "/api/ping") {
      return jsonResponse({
        ok: true,
        ts: Date.now(),
        kv_bound: !!env.DATA_KV,
      });
    }

    // Everything else → static assets (the index.html, /strategic-hub/, etc.)
    return env.ASSETS.fetch(request);
  },
};
