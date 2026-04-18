export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "OPENROUTER_API_KEY not set" });

  try {
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }

    const formattedMessages = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages.map((m) => ({
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.find((c) => c.type === "text")?.text || ""
          : m.content,
      })),
    ];

    const openRouterRes = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://blueledger.co.in",
          "X-Title": "BlueLedger",
        },
        body: JSON.stringify({
          model: "google/gemma-3-4b-it:free",          
          messages: formattedMessages,
          max_tokens: 1000,
        }),
      },
    );

    const data = await openRouterRes.json();

    if (!openRouterRes.ok) {
      console.error(
        "OpenRouter API error:",
        openRouterRes.status,
        JSON.stringify(data),
      );
      return res.status(openRouterRes.status).json({
        error: data?.error?.message || "OpenRouter API error",
      });
    }

    const text = data.choices?.[0]?.message?.content || "";
    return res.status(200).json({
      content: [{ type: "text", text }],
    });
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Proxy error: " + err.message });
  }
}
