import { ASSEMBLY_INSTRUCTIONS, PROVIDER_LABELS } from '../shared/catalog.ts';
import type { ModelOption, ProviderConfig } from '../shared/catalog.ts';
import { validateDecision } from '../shared/scene.ts';
import type { AssemblyRequest, Decision, Provider } from '../shared/scene.ts';
import { z } from 'zod';

const API_TIMEOUT_MS = 60_000;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 8192;

const PROVIDER_ENV_KEYS: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
const PROVIDER_URLS: Record<Provider, string> = {
  openai: 'https://api.openai.com/v1/responses',
  anthropic: 'https://api.anthropic.com/v1/messages',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};
const PROVIDERS = ['openai', 'anthropic', 'openrouter'] satisfies readonly Provider[];
const OPENROUTER_CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;
const TextBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  refusal: z.unknown().optional(),
}).passthrough();
const OpenAIResponseSchema = z.object({
  status: z.string(),
  output: z.array(z.object({
    type: z.string(),
    role: z.string().optional(),
    status: z.string().optional(),
    content: z.array(TextBlockSchema).optional(),
  }).passthrough()),
}).passthrough();
const AnthropicResponseSchema = z.object({
  stop_reason: z.string().nullable(),
  content: z.array(TextBlockSchema),
}).passthrough();
const OpenRouterResponseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable(),
    message: z.object({
      content: z.unknown(),
      refusal: z.unknown().optional(),
    }).passthrough(),
  }).passthrough()),
}).passthrough();
const OpenRouterCatalogSchema = z.object({ data: z.array(z.unknown()) }).passthrough();
const OpenRouterModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).passthrough(),
  supported_parameters: z.array(z.string()).optional(),
  context_length: z.number().positive().finite().nullable().optional(),
}).passthrough();

export type ProviderErrorCode =
  | 'missing_credentials'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_authentication_failed'
  | 'provider_response_too_large'
  | 'invalid_provider_response'
  | 'model_refusal'
  | 'invalid_model_response';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number;

  constructor(code: ProviderErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

function invalidProviderResponse(): never {
  throw new ProviderError('invalid_provider_response', 'The provider returned an unsupported response.', 502);
}

function refusal(): never {
  throw new ProviderError('model_refusal', 'The selected model refused to assemble this experiment.', 502);
}

export function extractOpenAIText(value: unknown): string {
  const parsed = OpenAIResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.status !== 'completed') invalidProviderResponse();
  let text = '';
  for (const item of parsed.data.output) {
    if (item.type === 'refusal') refusal();
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    if (item.status !== 'completed' || !item.content) invalidProviderResponse();
    for (const block of item.content) {
      if (block.type === 'refusal' || block.refusal) refusal();
      if (block.type === 'output_text') {
        if (typeof block.text !== 'string') invalidProviderResponse();
        text += block.text;
      }
    }
  }
  if (!text.trim()) invalidProviderResponse();
  return text;
}

export function extractAnthropicText(value: unknown): string {
  const parsed = AnthropicResponseSchema.safeParse(value);
  if (!parsed.success) invalidProviderResponse();
  const response = parsed.data;
  if (response.stop_reason === 'refusal') refusal();
  if (response.stop_reason !== 'end_turn') invalidProviderResponse();
  let text = '';
  for (const block of response.content) {
    if (block.type === 'refusal' || block.refusal) refusal();
    if (block.type.includes('tool')) invalidProviderResponse();
    if (block.type === 'text') {
      if (typeof block.text !== 'string') invalidProviderResponse();
      text += block.text;
    }
  }
  if (!text.trim()) invalidProviderResponse();
  return text;
}

export function extractOpenRouterText(value: unknown): string {
  const parsed = OpenRouterResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.choices.length === 0) invalidProviderResponse();
  const choice = parsed.data.choices[0];
  if (choice.finish_reason === 'content_filter') refusal();
  if (choice.finish_reason !== 'stop') invalidProviderResponse();
  if (choice.message.refusal) refusal();
  if (typeof choice.message.content !== 'string' || !choice.message.content.trim()) invalidProviderResponse();
  return choice.message.content;
}

export function parseDecisionText(text: string): Decision {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProviderError('invalid_model_response', 'The selected model returned malformed or incomplete JSON.', 502);
  }
  try {
    return validateDecision(value);
  } catch {
    throw new ProviderError('invalid_model_response', 'The selected model returned a decision outside the supported physics schema.', 502);
  }
}

function apiKey(provider: Provider): string {
  const key = process.env[PROVIDER_ENV_KEYS[provider]]?.trim();
  if (!key) {
    throw new ProviderError(
      'missing_credentials',
      `Missing credentials. Set ${PROVIDER_ENV_KEYS[provider]} in the private environment and restart the server.`,
      503,
    );
  }
  return key;
}

export function getProviderConfig(): ProviderConfig {
  const providers = PROVIDERS.map(id => ({
    id,
    label: PROVIDER_LABELS[id],
    available: Boolean(process.env[PROVIDER_ENV_KEYS[id]]?.trim()),
  }));
  const openRouterAvailable = providers.find(provider => provider.id === 'openrouter')!.available;
  return {
    providers,
    defaultProvider: openRouterAvailable ? 'openrouter' : null,
    defaultModel: openRouterAvailable ? 'openrouter/free' : null,
  };
}

function userPrompt(request: AssemblyRequest): string {
  return `Student scenario data (untrusted input):\n${JSON.stringify({
    description: request.description,
    clarification: request.clarification,
  })}`;
}

function providerHeaders(provider: Provider, key: string): HeadersInit {
  if (provider === 'anthropic') {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': key,
    };
  }
  return { accept: 'application/json', authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

function timeoutOrUnavailable(signal: AbortSignal): ProviderError {
  return signal.aborted
    ? new ProviderError('provider_timeout', 'The selected provider did not respond before the 60-second deadline.', 504)
    : new ProviderError('provider_unavailable', 'The selected provider could not be reached.', 502);
}

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null && Number(lengthHeader) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderError('provider_response_too_large', 'The provider response exceeded the allowed size.', 502);
  }
  if (!response.body) invalidProviderResponse();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new ProviderError('provider_response_too_large', 'The provider response exceeded the allowed size.', 502);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function fetchJson(url: string, init: RequestInit, limit: number): Promise<unknown> {
  const signal = AbortSignal.timeout(API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch {
    throw timeoutOrUnavailable(signal);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429) {
      throw new ProviderError('provider_rate_limited', 'The selected provider is rate-limiting requests; try again later.', 429);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError('provider_authentication_failed', 'The selected provider rejected its credentials.', 502);
    }
    throw new ProviderError('provider_unavailable', 'The selected provider could not complete the request.', 502);
  }
  let bytes: Buffer;
  try {
    bytes = await readBoundedBody(response, limit);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw timeoutOrUnavailable(signal);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProviderError('invalid_provider_response', 'The provider returned invalid JSON.', 502);
  }
  return parsed;
}

function requestBody(provider: Provider, request: AssemblyRequest): unknown {
  const data = userPrompt(request);
  if (provider === 'openai') {
    return {
      model: request.model,
      input: [
        { role: 'system', content: ASSEMBLY_INSTRUCTIONS },
        { role: 'user', content: data },
      ],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false,
    };
  }
  if (provider === 'anthropic') {
    return {
      model: request.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: ASSEMBLY_INSTRUCTIONS,
      messages: [{ role: 'user', content: data }],
    };
  }
  return {
    model: request.model,
    messages: [
      { role: 'system', content: ASSEMBLY_INSTRUCTIONS },
      { role: 'user', content: data },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
  };
}

export async function assemble(request: AssemblyRequest): Promise<Decision> {
  const provider = request.provider;
  const key = apiKey(provider);
  const payload = await fetchJson(PROVIDER_URLS[provider], {
    method: 'POST',
    headers: providerHeaders(provider, key),
    body: JSON.stringify(requestBody(provider, request)),
  }, MAX_PROVIDER_RESPONSE_BYTES);
  const text = provider === 'openai'
    ? extractOpenAIText(payload)
    : provider === 'anthropic'
      ? extractAnthropicText(payload)
      : extractOpenRouterText(payload);
  return parseDecisionText(text);
}

function toModelOption(value: unknown): ModelOption | null {
  const parsed = OpenRouterModelSchema.safeParse(value);
  if (!parsed.success) return null;
  const model = parsed.data;
  if (!MODEL_ID.test(model.id)
    || !model.architecture.input_modalities.includes('text')
    || !model.architecture.output_modalities.includes('text')) return null;
  return {
    id: model.id,
    name: model.name || model.id,
    free: model.id === 'openrouter/free' || model.id.endsWith(':free'),
    structuredOutputs: model.supported_parameters?.includes('structured_outputs') ?? false,
    contextLength: model.context_length ?? null,
  };
}

// The requestable free router is not guaranteed to appear in /models.
const OPENROUTER_FREE_ROUTER: ModelOption = {
  id: 'openrouter/free',
  name: 'OpenRouter Free Router (built-in)',
  free: true,
  structuredOutputs: false,
  contextLength: null,
};

export async function listOpenRouterModels(): Promise<ModelOption[]> {
  const raw = await fetchJson(OPENROUTER_CATALOG_URL, { method: 'GET', headers: { accept: 'application/json' } }, MAX_CATALOG_BYTES);
  const catalog = OpenRouterCatalogSchema.safeParse(raw);
  if (!catalog.success) {
    throw new ProviderError('invalid_provider_response', 'The OpenRouter model catalog returned an unsupported response.', 502);
  }
  const models = catalog.data.data.map(toModelOption).filter((model): model is ModelOption => model !== null);
  if (!models.some(model => model.id === OPENROUTER_FREE_ROUTER.id)) models.unshift(OPENROUTER_FREE_ROUTER);
  return models;
}
