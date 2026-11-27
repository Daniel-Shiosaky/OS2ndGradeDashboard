// Thin abstraction so the AI backend can be swapped via env vars without
// touching the extraction pipeline. Never hard-code API keys here.

export interface AiCallOptions {
  systemPrompt: string;
  userPrompt: string;
}

export interface AiProvider {
  complete(options: AiCallOptions): Promise<string>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function timeoutMs(): number {
  const raw = process.env.AI_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

// Statuses worth retrying: rate limits and transient server-side overload
// (free-tier Gemini in particular returns 503 "high demand" fairly often).
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;

/** Never wait longer than this on a server hint, so a job can't hang for hours. */
const MAX_RETRY_WAIT_MS = 90_000;

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Server-advised wait before retrying, if it told us one. */
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * Extracts a retry delay the provider explicitly asked for. Rate-limited
 * providers usually say exactly how long to wait, and guessing instead is why a
 * "retry in 8.9s" response used to fail after ~3s of blind backoff.
 *
 * Handles the standard `Retry-After` header (seconds or HTTP date) plus
 * Gemini's `RetryInfo.retryDelay` / "Please retry in 8.92s" body forms.
 */
export function parseRetryDelayMs(headers: Headers, body: string): number | undefined {
  const header = headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const retryInfo = body.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
  if (retryInfo) return Math.ceil(Number(retryInfo[1]) * 1000);
  const prose = body.match(/retry in ([\d.]+)\s*s/i);
  if (prose) return Math.ceil(Number(prose[1]) * 1000);
  return undefined;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof ApiError && RETRYABLE_STATUS.has(err.status);
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      const backoffMs = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      // Respect the provider's own figure when it exceeds our backoff; retrying
      // sooner than asked just burns the remaining attempts on the same error.
      const delayMs = Math.min(Math.max(backoffMs, err.retryAfterMs ?? 0), MAX_RETRY_WAIT_MS);
      const hint = err.retryAfterMs ? ` (server asked for ${err.retryAfterMs}ms)` : "";
      console.log(
        `  AI request failed (${err.status}), retrying in ${delayMs}ms${hint} (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

class AnthropicProvider implements AiProvider {
  async complete({ systemPrompt, userPrompt }: AiCallOptions): Promise<string> {
    const apiKey = requireEnv("AI_API_KEY");
    const model = process.env.AI_MODEL ?? "claude-sonnet-5";

    return withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs());
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text();
          throw new ApiError(
            `Anthropic API error ${response.status}: ${body}`,
            response.status,
            parseRetryDelayMs(response.headers, body),
          );
        }

        const data = (await response.json()) as {
          content: Array<{ type: string; text?: string }>;
        };
        const text = data.content.find((block) => block.type === "text")?.text;
        if (!text) {
          throw new Error("Anthropic response contained no text content");
        }
        return text;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

class OpenAiProvider implements AiProvider {
  async complete({ systemPrompt, userPrompt }: AiCallOptions): Promise<string> {
    const apiKey = requireEnv("AI_API_KEY");
    const model = process.env.AI_MODEL ?? "gpt-4o-mini";

    return withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs());
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text();
          throw new ApiError(
            `OpenAI API error ${response.status}: ${body}`,
            response.status,
            parseRetryDelayMs(response.headers, body),
          );
        }

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        const text = data.choices[0]?.message.content;
        if (!text) {
          throw new Error("OpenAI response contained no content");
        }
        return text;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

class GeminiProvider implements AiProvider {
  async complete({ systemPrompt, userPrompt }: AiCallOptions): Promise<string> {
    const apiKey = requireEnv("AI_API_KEY");
    const model = process.env.AI_MODEL ?? "gemini-flash-latest";

    return withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs());
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: "user", parts: [{ text: userPrompt }] }],
              generationConfig: { temperature: 0 },
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const body = await response.text();
          throw new ApiError(
            `Gemini API error ${response.status}: ${body}`,
            response.status,
            parseRetryDelayMs(response.headers, body),
          );
        }

        const data = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
        if (!text) {
          throw new Error("Gemini response contained no text content");
        }
        return text;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

export function getAiProvider(): AiProvider {
  const provider = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAiProvider();
    case "gemini":
      return new GeminiProvider();
    default:
      throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
  }
}
