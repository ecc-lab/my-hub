// Cloudflare Pages Function — /api/data/:key
// GET  → reads the JSON stored under `key` in KV namespace DATA_KV
// POST → overwrites the JSON stored under `key` in KV namespace DATA_KV
//
// Requires a KV binding named DATA_KV on the Pages project
// (Settings → Functions → KV namespace bindings)

const MAX_BYTES = 1_000_000; // 1 MB safety cap

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate",
};

export async function onRequestGet({ params, env }) {
  if (!env.DATA_KV) {
    return new Response(
      JSON.stringify({ error: "KV binding DATA_KV not configured" }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const key = params.key;
  const value = await env.DATA_KV.get(key);
  return new Response(value ?? "null", { headers: jsonHeaders });
}

export async function onRequestPost({ params, env, request }) {
  if (!env.DATA_KV) {
    return new Response(
      JSON.stringify({ error: "KV binding DATA_KV not configured" }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const key = params.key;
  const body = await request.text();

  if (body.length > MAX_BYTES) {
    return new Response(
      JSON.stringify({ error: "payload too large", limit: MAX_BYTES }),
      { status: 413, headers: jsonHeaders }
    );
  }

  // Ensure body is valid JSON
  try {
    JSON.parse(body);
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: jsonHeaders }
    );
  }

  await env.DATA_KV.put(key, body);
  return new Response(
    JSON.stringify({ ok: true, key, size: body.length }),
    { headers: jsonHeaders }
  );
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      "allow": "GET, POST, OPTIONS",
      "cache-control": "no-store",
    },
  });
}
