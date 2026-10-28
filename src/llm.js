import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Model bi 429 (het luot goi / quota) -> tam BO QUA 1 luc, chuyen thang sang model du phong
// thay vi lan nao cung thu lai roi moi chuyen (test 27/09: moi cau 27-42s vi 3.6-flash 429).
// Dung chung cho moi ham ask trong process (router, tra loi, chuan hoa cau day...).
const cooldownUntil = new Map(); // model id -> ms
const COOLDOWN_MS = 2 * 60 * 1000;
const isRateLimit = (err) => err?.statusCode === 429 || /too many requests|resource_exhausted|quota|rate limit/i.test(String(err?.message));

// Endpoint OpenAI-compatible -> doi qua lai Gemini / DeepSeek / Qwen chi bang .env.
// Model chinh hay bi 503 luc qua tai -> retry it roi chuyen sang model du phong,
// thay vi de SDK tu retry 3 lan (~16s) roi chet.
export function createLlm({ baseURL, apiKey, model, fallbackModels = [], textTimeoutMs = 25000 }) {
  const provider = createOpenAICompatible({ name: "llm", baseURL, apiKey });
  const models = [model, ...fallbackModels];

  // image = { data: Buffer, mediaType } -> gui kem anh (Gemini doc duoc anh chup man hinh).
  return async function ask({ system, prompt, image }) {
    const now = Date.now();
    const ready = models.filter((id) => (cooldownUntil.get(id) || 0) <= now);
    let lastErr;
    for (const id of ready.length ? ready : models) {
      try {
        const { text } = await generateText({
          model: provider.chatModel(id),
          system,
          ...(image
            ? { messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "file", data: image.data, mediaType: image.mediaType }] }] }
            : { prompt }),
          temperature: 0.2,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(textTimeoutMs),
        });
        return (text || "").trim();
      } catch (err) {
        lastErr = err;
        if (isRateLimit(err)) cooldownUntil.set(id, Date.now() + COOLDOWN_MS);
        console.warn(`[llm] ${id} loi${isRateLimit(err) ? " (429, tam bo qua 2 phut)" : ""}: ${String(err.message).slice(0, 120)}`);
      }
    }
    throw lastErr;
  };
}
