/* ═══════════════════════════════════════════════════════════════
   /api/ai.js  —  Vercel Serverless Proxy for Anthropic API

   WHY THIS EXISTS:
   Anthropic blocks direct browser→API calls with CORS (intentional —
   it prevents API keys from being exposed in client-side code).
   This function runs on Vercel's servers, holds the key securely
   in an environment variable, and forwards requests from your
   frontend to Anthropic.

   SECURITY MODEL:
   - API key lives ONLY in Vercel environment variable ANTHROPIC_API_KEY
   - Key is never sent to the browser
   - You can add origin checking (see below) to restrict to your domain
   - Rate limiting can be added here if needed

   SETUP (one-time):
   1. Deploy this file to your Vercel repo (it auto-deploys as a
      serverless function at https://blueledger.co.in/api/ai)
   2. In Vercel dashboard → Project → Settings → Environment Variables:
      Add:  ANTHROPIC_API_KEY  =  sk-ant-...your key...
   3. Redeploy once for the env var to take effect

   FRONTEND CHANGE:
   In ai.js, change _callAI to POST to "/api/ai" instead of
   "https://api.anthropic.com/v1/messages"
   ═══════════════════════════════════════════════════════════════ */

export default async function handler(req, res) {
  /* ── Only allow POST ──────────────────────────────────────── */
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  /* ── Optional: restrict to your own domain ───────────────── */
  const origin = req.headers.origin || "";
  const allowed = [
    "https://blueledger.co.in",
    "https://www.blueledger.co.in",
    "http://localhost", // for local dev
    "http://127.0.0.1",
  ];
  // Uncomment to enforce origin restriction:
  // if (!allowed.some(o => origin.startsWith(o))) {
  //   return res.status(403).json({ error: "Forbidden" });
  // }

  /* ── CORS headers so browser fetch() succeeds ────────────── */
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  /* Handle preflight */
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  /* ── Validate API key is configured ─────────────────────── */
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY environment variable not set");
    return res.status(500).json({
      error:
        "AI service not configured. Set ANTHROPIC_API_KEY in Vercel environment variables.",
    });
  }

  /* ── Forward request to Anthropic ───────────────────────── */
  try {
    const { model, max_tokens, system, messages } = req.body;

    /* Basic validation */
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-20250514",
        max_tokens: max_tokens || 1000,
        system: system || "",
        messages,
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error("Anthropic API error:", anthropicRes.status, data);
      return res.status(anthropicRes.status).json({
        error: data?.error?.message || "Anthropic API error",
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    return res
      .status(500)
      .json({ error: "Internal proxy error: " + err.message });
  }
}
