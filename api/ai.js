export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

  try {
    const { messages, system } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }

    const contents = messages.map((m) => {
      const role = m.role === "assistant" ? "model" : "user";

      if (typeof m.content === "string") {
        return { role, parts: [{ text: m.content }] };
      }

      if (Array.isArray(m.content)) {
        const parts = m.content.map((block) => {
          if (block.type === "text") return { text: block.text };
          if (block.type === "image" && block.source?.type === "base64") {
            return {
              inline_data: {
                mime_type: block.source.media_type || "image/jpeg",
                data: block.source.data,
              },
            };
          }
          return { text: JSON.stringify(block) };
        });
        return { role, parts };
      }

      return { role, parts: [{ text: String(m.content || "") }] };
    });

    const body = {
      contents,
      generationConfig: { maxOutputTokens: 1000 },
    };

    if (system) {
      body.system_instruction = { parts: [{ text: system }] };
    }

    const geminiRes = await fetch(
`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error(
        "Gemini API error:",
        geminiRes.status,
        JSON.stringify(data),
      );
      return res.status(geminiRes.status).json({
        error: data?.error?.message || "Gemini API error",
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return res.status(200).json({
      content: [{ type: "text", text }],
    });
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Proxy error: " + err.message });
  }
}
