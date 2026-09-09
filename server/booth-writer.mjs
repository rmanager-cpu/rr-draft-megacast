// The writer. Claude drafts the booth's lines; nothing it writes reaches the
// speaker without passing the deterministic checks first, and every path here
// can fail without the show noticing.
//
// Two properties matter more than quality:
//   1. It is optional. No key, no network, a timeout, a bad response - the booth
//      falls back to a written line and carries on. The show never waits.
//   2. It only ever sees the packet. The prompt hands it the facts it is allowed
//      to use and tells it plainly that anything else is a lie about a real
//      person sitting in the room.

import Anthropic from "@anthropic-ai/sdk";
import { openaiText } from "./openai.mjs";

const MODEL = "claude-opus-5";

export function createWriter({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = MODEL,
  // With no Anthropic key, an OpenAI key does the same job. Anthropic wins if both are set.
  openaiKey = process.env.OPENAI_API_KEY,
  openaiModel = process.env.OPENAI_MODEL || "gpt-5",
  bible = "",
  onWarn = () => {},
  onInfo = () => {},
} = {}) {
  const client = apiKey ? new Anthropic({ apiKey }) : null;
  let fallbacksSupported = true;

  async function ask({ system, user, maxTokens, effort, timeoutMs }) {
    if (!client) {
      if (!openaiKey) return null;
      return openaiText({ apiKey: openaiKey, model: openaiModel, system, user, maxTokens, timeoutMs, onWarn });
    }
    const body = {
      model,
      max_tokens: maxTokens,
      // The bible is the same on every call, so it is worth caching. Volatile
      // content goes after it, never before, or the cache never hits.
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{ role: "user", content: user }],
      thinking: { type: "adaptive" },
      output_config: { effort },
    };

    const call = async (withFallbacks) => {
      const opts = { timeout: timeoutMs };
      if (!withFallbacks) return client.messages.create(body, opts);
      return client.beta.messages.create(
        { ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
        opts,
      );
    };

    let res;
    try {
      res = await call(fallbacksSupported);
    } catch (e) {
      // If this build of the API does not know the fallback beta, stop asking
      // for it rather than losing the booth over an optional safety net.
      if (fallbacksSupported && /fallback|beta/i.test(e?.message ?? "")) {
        fallbacksSupported = false;
        onInfo("booth: server-side fallbacks unavailable, continuing without them");
        try {
          res = await call(false);
        } catch (e2) {
          onWarn("booth writer: " + e2.message);
          return null;
        }
      } else {
        onWarn("booth writer: " + e.message);
        return null;
      }
    }

    if (res.stop_reason === "refusal") {
      onWarn("booth writer declined the request");
      return null;
    }
    const text = (res.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    return text || null;
  }

  const rules = `
You are writing lines for a live fantasy football draft broadcast in a private
league. Twelve people are in the room and they know each other.

Absolute rules:
- Use ONLY the facts in the packet. If a number is not in the packet, do not say
  a number. If a name is not in the packet, do not say a name.
- Never mention an injury, a trade, a suspension, a release, a holdout or a legal
  matter unless the packet's note says it. These are real people.
- Do not invent statistics, history, or anything about a player's season.
- If you have nothing specific to say, say something short about the draft
  itself - the round, the value, the run on a position. Vague is fine. False is not.
- Write to be spoken aloud. No lists, no headings, no stage directions.
`.trim();

  return {
    get available() {
      return !!client || !!openaiKey;
    },
    /** A short reaction. Perishable, so it asks for speed over depth. */
    async line({ packet, persona = "", maxChars = 240, timeoutMs = 8000 }) {
      const system = [rules, bible, persona].filter(Boolean).join("\n\n");
      const user =
        `Packet:\n${JSON.stringify(packet, null, 2)}\n\n` +
        `Write ONE sentence, at most ${maxChars} characters, to be said out loud ` +
        `the moment this pick lands. Return only the sentence.`;
      return ask({ system, user, maxTokens: 400, effort: "low", timeoutMs });
    },
    /** The round recap: commentary on the picks worth a word, not a list of the round. */
    async recap({ packet, persona = "", timeoutMs = 45000 }) {
      const system = [rules, bible, persona].filter(Boolean).join("\n\n");
      const user =
        `Packet:\n${JSON.stringify(packet, null, 2)}\n\n` +
        `Write spoken commentary on this round: at most ${packet.seconds ?? 75} seconds, ` +
        `about ${Math.round((packet.seconds ?? 75) * 2.4)} words, shorter if there is less ` +
        `to say. Give a real opinion on every pick marked interesting and on nothing else. A why ` +
        `of "lean: dislike" means be hard on that pick; "lean: love" means admire it. ` +
        `Do not run through the rest of the round and do ` +
        `not list every pick; the board is on the wall. Note any position run the packet ` +
        `reports. Return only what is to be said.`;
      return ask({ system, user, maxTokens: 2000, effort: "medium", timeoutMs });
    },
  };
}
