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
  if (!token || !event || event.type !== "message" || !event.source ||
      event.source.type !== "user" || !event.source.userId || !event.message ||
      !["text", "image"].includes(event.message.type)) return false;

  try {
    const response = await fetch("https://api.line.me/v2/bot/chat/loading/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ chatId: event.source.userId, loadingSeconds: 60 })
    });
    if (!response.ok) {
      console.warn("LINE loading animation was not started", response.status, (await response.text()).slice(0, 500));
      return false;
    }
    event.lineLoadingStartedByWorker = true;
    return true;
  } catch (error) {
    console.warn("LINE loading animation request failed", String(error.message || error));
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
        queueConfigured: Boolean(env.LINE_EVENTS_QUEUE && typeof env.LINE_EVENTS_QUEUE.send === "function"),
        time: new Date().toISOString()
      });
    }

    // LINE webhook route: verify signature, enqueue each event, respond immediately.
    // Do not use waitUntil for AI/image processing: it is cancelled after the
    // Cloudflare waitUntil lifetime. A Queue consumer gives the task a durable
    // retry path and a much longer processing window.
    if (path === "/line") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }
      if (!env.LINE_EVENTS_QUEUE || typeof env.LINE_EVENTS_QUEUE.send !== "function") {
        console.error("LINE_EVENTS_QUEUE binding is missing");
        return json({ ok: false, error: "LINE_EVENTS_QUEUE binding is missing. Configure the Cloudflare Queue producer binding first." }, 503);
      }

      try {
        const rawBody = await request.text();
        const signature = request.headers.get("x-line-signature");
        const verified = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
        if (!verified) return json({ ok: false, error: "Invalid LINE webhook signature" }, 401);

        let webhookBody;
        try { webhookBody = JSON.parse(rawBody); }
        catch { return json({ ok: false, error: "Invalid JSON webhook body" }, 400); }

        const events = Array.isArray(webhookBody.events) ? webhookBody.events : [];
        if (events.length) {
          await Promise.all(events.map(event => env.LINE_EVENTS_QUEUE.send({
            destination: String(webhookBody.destination || ""),
            event: event,
            queuedAt: new Date().toISOString()
          })));
        }
        return json({ ok: true, accepted: true, queued: events.length }, 200);
      } catch (error) {
        console.error("LINE webhook enqueue failed", String(error.message || error));
        return json({ ok: false, error: String(error.message || error) }, 503);
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
  },

  // Cloudflare Queue consumer. Configure batch size 1 and max retries 3 in
  // Cloudflare Dashboard; attach a dead-letter queue to retain poison messages.
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const job = message.body || {};
      const event = job.event;
      const eventId = event && event.webhookEventId ? String(event.webhookEventId) : "";
      try {
        if (!job.event || typeof job.event !== "object") {
          console.error("Invalid queue message", JSON.stringify({ eventId, attempts: message.attempts }));
          message.ack();
          continue;
        }

        await startLoadingForWebhookEvent(event, env);
        const response = await forwardToAppsScript({
          kind: "line_webhook",
          signatureVerified: true,
          body: { destination: String(job.destination || ""), events: [event] }
        }, env);
        const responseText = await response.text();
        let data = null;
        try { data = JSON.parse(responseText); } catch (_) {}

        const eventResults = data && data.result && Array.isArray(data.result.results)
          ? data.result.results : [];
        if (!response.ok || !data || data.ok === false) {
          throw new Error("Apps Script request failed: " + JSON.stringify({
            status: response.status,
            response: responseText.slice(0, 2500)
          }));
        }
        // A single queued item must produce one result from doPost. Treat a
        // non-matching deployment/response as failure rather than silently ack.
        if (!data.result || !Array.isArray(data.result.results)) {
          throw new Error("Unexpected Apps Script response shape; expected result.results[]. Response: " + responseText.slice(0, 2500));
        }
        const pending = eventResults.some(item => item && item.pending === true);
        if (pending) {
          console.warn("Webhook event is still processing; retrying queue message", JSON.stringify({ eventId, attempts: message.attempts || 1 }));
          message.retry({ delaySeconds: 60 });
          continue;
        }

        const eventErrors = eventResults.filter(item => item && item.ok === false);
        if (eventResults.length === 0 || eventErrors.length) {
          throw new Error("Apps Script event processing failed: " + JSON.stringify({
            status: response.status,
            response: responseText.slice(0, 2500),
            eventErrors: eventErrors.slice(0, 5)
          }));
        }

        console.log("FINORA queue event processed", JSON.stringify({
          eventId,
          eventType: event.type || "unknown",
          attempts: message.attempts || 1,
          outcomes: eventResults.slice(0, 5).map(item => ({
            ok: item && item.ok,
            handledBy: item && item.handledBy,
            eventType: item && item.eventType,
            messageType: item && item.messageType,
            duplicate: item && item.duplicate === true,
            ignored: item && item.ignored === true,
            pending: item && item.pending === true,
            error: item && item.error ? String(item.error).slice(0, 500) : ""
          }))
        }));
        message.ack();
      } catch (error) {
        console.error("FINORA queue event failed", JSON.stringify({
          eventId,
          attempts: message.attempts || 1,
          error: String(error.message || error).slice(0, 3000)
        }));
        // Queue consumer retry and dead-letter handling are configured in the
        // dashboard. A delay prevents a rapid retry loop against Apps Script.
        message.retry({ delaySeconds: Math.min(60 * Math.max(Number(message.attempts || 1), 1), 300) });
      }
    }
  }
};
