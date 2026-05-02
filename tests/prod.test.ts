import { expect, test } from "bun:test";

const NUM_CALLS = 20;

interface LLMRequest {
  model: string;
  prompt: string;
  temperature: number;
  apiKey: string;
}

interface LLMResponse {
  content?: string;
  [key: string]: unknown;
}

// lightweight fetch wrapper around global fetch
async function ffetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

const BASE_URL = "http://localhost:3000/v1";

async function callLLM(prompt: string): Promise<LLMResponse> {
  const payload: LLMRequest = {
    model: "groq/compound",
    prompt,
    temperature: 0.7,
    apiKey: "dummy",
  };

  const res = await ffetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return res.json() as Promise<LLMResponse>;
}

test(`should respond to ${NUM_CALLS} concurrent calls`, async () => {
  const promises: Promise<LLMResponse>[] = Array.from({ length: NUM_CALLS }, (_, i) =>
    callLLM(`Test ${i}`),
  );

  const results: LLMResponse[] = await Promise.all(promises);

  expect(results.length).toBe(NUM_CALLS);
  expect(results[0]?.content).toBeDefined();
}, 180000);