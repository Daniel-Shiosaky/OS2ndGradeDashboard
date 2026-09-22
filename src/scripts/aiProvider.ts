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

class AnthropicProvider implements AiProvider {
  async complete({ systemPrompt, userPrompt }: AiCallOptions): Promise<string> {
    const apiKey = requireEnv("AI_API_KEY");
    const model = process.env.AI_MODEL ?? "claude-sonnet-5";

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
        throw new Error(`Anthropic API error ${response.status}: ${body}`);
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
  }
}

class OpenAiProvider implements AiProvider {
  async complete({ systemPrompt, userPrompt }: AiCallOptions): Promise<string> {
    const apiKey = requireEnv("AI_API_KEY");
    const model = process.env.AI_MODEL ?? "gpt-4o-mini";

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
        throw new Error(`OpenAI API error ${response.status}: ${body}`);
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
  }
}

export function getAiProvider(): AiProvider {
  const provider = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAiProvider();
    default:
      throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
  }
}
