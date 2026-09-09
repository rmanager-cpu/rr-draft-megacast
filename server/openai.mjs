// The OpenAI path for the booth: one key, and both the writer and the voice
// can use it. Plain fetch, no SDK, so there is nothing to install.
//
// Same two properties as the Anthropic and ElevenLabs paths: it is optional,
// and it only ever sees what it is handed. A missing key, a timeout, or a bad
// response returns null and the booth falls back exactly as before.

const CHAT = "https://api.openai.com/v1/chat/completions";
const SPEECH = "https://api.openai.com/v1/audio/speech";

/** Ask for text. Returns the text, or null on any failure. Never throws. */
export async function openaiText({ apiKey, model = "gpt-5", system, user, maxTokens = 800, timeoutMs = 20000, onWarn = () => {} }) {
  if (!apiKey) return null;
  try {
    const r = await fetch(CHAT, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // Reasoning models spend their budget thinking first. Keep that short,
        // and leave room for the words: a line has to land inside ten seconds.
        max_completion_tokens: Math.max(maxTokens, 1200),
        ...(model.startsWith("gpt-5") || model.startsWith("o") ? { reasoning_effort: "minimal" } : {}),
      }),
    });
    if (!r.ok) {
      onWarn("openai writer: HTTP " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const j = await r.json();
    const choice = j.choices?.[0];
    if (choice?.finish_reason === "content_filter") {
      onWarn("openai writer declined the request");
      return null;
    }
    const text = String(choice?.message?.content ?? "").trim();
    if (!text) onWarn("openai writer: empty reply, finish_reason " + (choice?.finish_reason ?? "?"));
    return text || null;
  } catch (e) {
    onWarn("openai writer: " + e.message);
    return null;
  }
}

/** Turn text into MP3 bytes. Returns a Buffer, or null on any failure. Never throws. */
export async function openaiSpeech({ apiKey, model = "gpt-4o-mini-tts", voice = "onyx", text, timeoutMs = 12000, onWarn = () => {} }) {
  if (!apiKey || !text) return null;
  try {
    const r = await fetch(SPEECH, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
    });
    if (!r.ok) {
      onWarn("openai voice: HTTP " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024) {
      onWarn("openai voice: response too small");
      return null;
    }
    return buf;
  } catch (e) {
    onWarn("openai voice: " + e.message);
    return null;
  }
}
