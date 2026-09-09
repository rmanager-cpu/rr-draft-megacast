// Turning a line into sound.
//
// Two voices when a key exists, the laptop's own voice when it does not. The
// fallback is not a stub: it is the path the show actually uses whenever the
// real voices are slow, rate limited, or down, so it stays wired in from the
// start rather than being discovered on the night.
//
// Everything rendered is cached by its text, so the open, the bits, and any
// repeated line cost nothing the second time.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "./persist.mjs";
import { openaiSpeech } from "./openai.mjs";

const API = "https://api.elevenlabs.io/v1/text-to-speech/";

export function createVoice({
  apiKey = process.env.ELEVENLABS_API_KEY,
  voices = {},
  dir = "data/audio/cache",
  modelId = "eleven_turbo_v2_5",
  // The OpenAI voices, used when ElevenLabs is not set up. Names, not ids:
  // onyx, ash, echo, alloy, fable, nova, sage, shimmer, coral, ballad, verse.
  openaiKey = process.env.OPENAI_API_KEY,
  openaiVoices = { play: process.env.OPENAI_VOICE_PLAY || "onyx", colour: process.env.OPENAI_VOICE_COLOUR || "ash" },
  onWarn = () => {},
} = {}) {
  ensureDir(dir);
  const key = (text, voiceId) => createHash("sha1").update(voiceId + "\u0000" + text).digest("hex").slice(0, 20);

  /**
   * @returns {Promise<{url:string}|null>} null means "say it with the system voice"
   */
  async function render(text, { voice = "play", timeoutMs = 12000 } = {}) {
    const voiceId = voices[voice] ?? voices.play ?? null;
    if (!text) return null;
    if (!apiKey || !voiceId) return renderOpenai(text, voice, timeoutMs);

    const name = key(text, voiceId) + ".mp3";
    const file = join(dir, name);
    if (existsSync(file)) return { url: "/audio/" + name, cached: true };

    try {
      const r = await fetch(API + voiceId, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3 },
        }),
      });
      if (!r.ok) {
        onWarn(`voice ${voice}: HTTP ${r.status}`);
        return null;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1024) {
        onWarn(`voice ${voice}: response too small`);
        return null;
      }
      await writeFile(file, buf);
      return { url: "/audio/" + name, cached: false };
    } catch (e) {
      onWarn(`voice ${voice}: ${e.message}`);
      return null;
    }
  }

  async function renderOpenai(text, voice, timeoutMs) {
    if (!openaiKey) return null;
    const name = "oa-" + key(text, openaiVoices[voice] ?? openaiVoices.play) + ".mp3";
    const file = join(dir, name);
    if (existsSync(file)) return { url: "/audio/" + name, cached: true };
    const buf = await openaiSpeech({ apiKey: openaiKey, voice: openaiVoices[voice] ?? openaiVoices.play, text, timeoutMs, onWarn });
    if (!buf) return null;
    await writeFile(file, buf);
    return { url: "/audio/" + name, cached: false };
  }

  return {
    render,
    dir,
    get available() {
      return (!!apiKey && Object.keys(voices).length > 0) || !!openaiKey;
    },
  };
}
