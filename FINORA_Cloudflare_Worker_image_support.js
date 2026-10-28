const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders
    }
  });
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || "").trim();

  if (!origin || !allowed || origin !== allowed) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return difference === 0;
}

function bytesToBase64(bytes) {
  let binary = "";

  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

/**
 * Verify LINE signature against the exact raw request body.
 * Do not parse or reformat the body before this verification.
 */
async function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rawBody)
  );

  const expected = bytesToBase64(digest);
  return safeEqual(expected, signature);
}

/**
 * Start LINE's native loading animation before forwarding the webhook to
 * Apps Script. This makes the dots appear earlier than starting it after
 * profile lookups, Google Sheets writes, automation checks, and Gemini.
 *
 * Set LINE_CHANNEL_ACCESS_TOKEN as a Cloudflare Worker Secret. If it is
 * absent or the LINE request fails, Apps Script performs a fallback attempt.
 * Only one-to-one text and image messages are eligible for this indicator.
 */
async function startLoadingForWebhookEvent(event, env) {
  const token = String(env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();

  if (!token) {
    return false;
  }

  if (
    !event ||
    event.type !== "message" ||
    !event.source ||
    event.source.type !== "user" ||
    !event.source.userId ||
    !event.message ||
    !["text", "image"].includes(event.message.type) ||
    (event.message.type === "text" && !String(event.message.text || "").trim())
  ) {
    return false;
  }

  try {
    const response = await fetch(
      "https://api.line.me/v2/bot/chat/loading/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          chatId: event.source.userId,
          loadingSeconds: 60
        })
      }
    );

    if (!response.ok) {
      // Do not block webhook processing; Apps Script will try the fallback.
      return false;
    }

    // This marker tells Apps Script not to make a duplicate loading request.
    event.lineLoadingStartedByWorker = true;
    return true;
  } catch (error) {
    // Fallback to the Apps Script loading request if the Worker call fails.
    return false;
  }
}

/**
 * Send a request to the Google Apps Script Web App.
 * The shared secret is inserted here on the server, never in index.html.
 */
async function forwardToAppsScript(envelope, env) {
  if (!env.GAS_WEB_APP_URL) {
    throw new Error("GAS_WEB_APP_URL is not configured");
  }

  if (!env.WORKER_SHARED_SECRET) {
    throw new Error("WORKER_SHARED_SECRET is not configured");
  }

  const body = {
    ...envelope,
    secret: env.WORKER_SHARED_SECRET
  };

  const upstream = await fetch(env.GAS_WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "follow"
  });

  const responseText = await upstream.text();

  if (!upstream.ok) {
    return json({
      ok: false,
      error: "Apps Script upstream request failed",
      upstreamStatus: upstream.status,
      details: responseText.slice(0, 1000)
    }, 502);
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    return json({
      ok: false,
      error: "Apps Script returned a non-JSON response",
      details: responseText.slice(0, 1000)
    }, 502);
  }

  return json(data);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get("Origin") || "";

    // Health endpoint: verifies Worker availability only.
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        service: "LINE AI Chatbot API Gateway",
        time: new Date().toISOString()
      });
    }

    // LINE webhook route.
    if (path === "/line") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      try {
        const rawBody = await request.text();
        const signature = request.headers.get("x-line-signature");
        const verified = await verifyLineSignature(
          rawBody,
          signature,
          env.LINE_CHANNEL_SECRET
        );

        if (!verified) {
          return json({
            ok: false,
            error: "Invalid LINE webhook signature"
          }, 401);
        }

        let webhookBody;

        try {
          webhookBody = JSON.parse(rawBody);
        } catch {
          return json({
            ok: false,
            error: "Invalid JSON webhook body"
          }, 400);
        }

        // Start native LINE dots before the slower Apps Script/Gemini path.
        // Each event is marked only if LINE accepts the loading request.
        if (Array.isArray(webhookBody.events)) {
          await Promise.all(
            webhookBody.events.map(event =>
              startLoadingForWebhookEvent(event, env)
            )
          );
        }

        // Acknowledge LINE immediately. Image download + Gemini inference can
        // take longer than LINE's webhook response window, so run the job in
        // the Worker background while preserving the verified event payload.
        const job = forwardToAppsScript({
          kind: "line_webhook",
          signatureVerified: true,
          body: webhookBody
        }, env).then(async response => {
          const responseText = await response.text();
          let data = null;
          try { data = JSON.parse(responseText); } catch (_) {}
          const eventErrors = data && data.result && Array.isArray(data.result.results)
            ? data.result.results.filter(item => item && item.ok === false)
            : [];
          if (!response.ok || (data && data.ok === false) || eventErrors.length) {
            console.error("Apps Script webhook processing reported an error", JSON.stringify({
              httpStatus: response.status,
              response: responseText.slice(0, 3000),
              eventErrors: eventErrors.slice(0, 10)
            }));
          } else {
            console.log("Apps Script webhook processed", JSON.stringify({
              httpStatus: response.status,
              events: data && data.result ? data.result.processed : undefined
            }));
          }
        }).catch(error => {
          console.error("Apps Script webhook forwarding failed", String(error.message || error));
        });

        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(job);
        } else {
          // Defensive fallback for non-Cloudflare test environments.
          await job;
        }

        return json({ ok: true, accepted: true }, 200);
      } catch (error) {
        return json({
          ok: false,
          error: String(error.message || error)
        }, 502);
      }
    }

    // Frontend API route.
    if (path === "/api") {
      const cors = corsHeaders(origin, env);
      const allowed = (env.ALLOWED_ORIGIN || "").trim();

      if (!origin || !allowed || origin !== allowed) {
        return json({
          ok: false,
          error: "Origin not allowed"
        }, 403);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }

      if (request.method !== "POST") {
        return json({
          ok: false,
          error: "Method not allowed"
        }, 405, cors);
      }

      let input;

      try {
        input = await request.json();
      } catch {
        return json({
          ok: false,
          error: "Request body must be valid JSON"
        }, 400, cors);
      }

      const action = String(input.action || "").trim();

      if (!action) {
        return json({ ok: false, error: "Missing action" }, 400, cors);
      }

      try {
        const result = await forwardToAppsScript({
          kind: "api",
          action,
          payload: input.payload || {}
        }, env);

        const headers = new Headers(result.headers);
        for (const [name, value] of Object.entries(cors)) {
          headers.set(name, value);
        }

        return new Response(result.body, {
          status: result.status,
          headers
        });
      } catch (error) {
        return json({
          ok: false,
          error: String(error.message || error)
        }, 502, cors);
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};
