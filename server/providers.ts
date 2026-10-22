import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { Api, Model, TranscriptContext, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { Provider as PiProvider } from '@earendil-works/pi-ai/models';
import { z } from 'zod';
import { CONNECTED_GPT_MODEL, PROVIDER_LABELS, type ModelOption, type ProviderConfig } from '../shared/catalog.ts';
import type { Provider } from '../shared/scene.ts';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { HarnessRequestSchema } from '../shared/harness.ts';
import { hostedDemo } from './demo.ts';
import { hostedSubscriptionKey } from './subscription-auth.ts';

const PROVIDER_ENV_KEYS: Record<Exclude<Provider, 'openai-codex'>, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const PROVIDERS = ['openrouter', 'openai', 'anthropic', 'openai-codex'] satisfies readonly Provider[];
const adapters: Record<Provider, PiProvider> = { openrouter: openrouterProvider(), openai: openaiProvider(), anthropic: anthropicProvider(), 'openai-codex': openaiCodexProvider() };
const ENDPOINTS = { openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com', 'openai-codex': 'https://chatgpt.com/backend-api' };
const execFileAsync = promisify(execFile);
const hostedFreeOnly = () => Boolean(process.env.PUBLIC_ORIGINS?.trim());
const connectedGptEnabled = () => process.env.PHYSICS_LAB_CONNECTED_GPT === '1'
  && (!hostedFreeOnly() || hostedDemo()!.deadline > Date.now());
function enforceHostedModel(provider: Provider, id: string): void {
  if (hostedFreeOnly() && provider === 'openai-codex' && connectedGptEnabled() && id === CONNECTED_GPT_MODEL) return;
  if (hostedFreeOnly() && (provider !== 'openrouter' || !(id.endsWith(':free') || id === 'openrouter/free'))) {
    throw new ProviderError('hosted_free_only', 'This public lab supports free OpenRouter models only.', 403);
  }
}
type OpenRouterCatalog = { at: number; models: ModelOption[]; imageInputs: Map<string, boolean> };
let cachedModels: OpenRouterCatalog | null = null;
let cachedConnectedGptInput: { at: number; input: Model<Api>['input'] } | null = null;

export class ProviderError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}
export async function providerKey(provider: Provider, signal?: AbortSignal): Promise<string> {
  if (hostedFreeOnly() && provider !== 'openrouter' && !(provider === 'openai-codex' && connectedGptEnabled())) {
    throw new ProviderError('hosted_free_only', 'This lab permits only free OpenRouter models or its active, authorized subscription demo.', 403);
  }
  if (provider === 'openai-codex') {
    if (!connectedGptEnabled()) throw new ProviderError('connection_not_enabled', 'Connected GPT has not been enabled by the person running this lab.', 403);
    try {
      const demo = hostedDemo();
      if (demo) return await hostedSubscriptionKey(demo.credentialSecret, demo.deadline, signal);
      const { stdout } = await execFileAsync('omp', ['token', 'openai-codex'], { timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, signal });
      const token = stdout.trim();
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Unsupported credential format.');
      return token;
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new ProviderError('missing_credentials', 'The authorized GPT connection could not be read or renewed. Ask the person running this lab to reconnect it.', 503);
    }
  }
  const key = process.env[PROVIDER_ENV_KEYS[provider]]?.trim();
  if (!key) throw new ProviderError('missing_credentials', `Set ${PROVIDER_ENV_KEYS[provider]} in the private server environment and restart the lab.`, 503);
  return key;
}
export function getProviderConfig(): ProviderConfig {
  const choices = hostedFreeOnly() ? connectedGptEnabled() ? ['openai-codex', 'openrouter'] as const : ['openrouter'] as const : PROVIDERS;
  const providers = choices.map(id => ({ id, label: PROVIDER_LABELS[id], available: id === 'openai-codex' ? connectedGptEnabled() : Boolean(process.env[PROVIDER_ENV_KEYS[id]]?.trim()) }));
  const available = connectedGptEnabled() ? providers.find(provider => provider.id === 'openai-codex') : providers.find(provider => provider.available);
  return { providers, defaultProvider: available?.id ?? null, defaultModel: available?.id === 'openai-codex' ? CONNECTED_GPT_MODEL : available?.id === 'openrouter' ? 'openrouter/free' : null };
}
export function labModel(provider: Provider, id: string): Model<Api> {
  enforceHostedModel(provider, id);
  if (provider === 'openai-codex' && id !== CONNECTED_GPT_MODEL) throw new ProviderError('unsupported_model', 'Connected GPT is configured for GPT-6 Luna.', 400);
  const known = adapters[provider].getModels().find(model => model.id === id);
  return {
    ...(known ?? { name: id, reasoning: provider === 'openai-codex', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: provider === 'openai-codex' ? 872000 : 131072, maxTokens: 8192 }),
    id, provider, baseUrl: ENDPOINTS[provider],
    api: provider === 'openai-codex' ? 'openai-codex-responses' : provider === 'openai' ? 'openai-responses' : provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    // No model-supplied headers, endpoints or sampling parameters cross the broker.
    headers: undefined, samplingParams: undefined,
    ...(provider === 'openai-codex' ? { thinkingLevelMap: { off: null, low: 'low', high: 'high' } } : {}),
  };
}
const ConnectedGptModelSchema = z.object({
  provider: z.literal('openai-codex'),
  id: z.literal(CONNECTED_GPT_MODEL),
  input: z.array(z.string()),
});
async function connectedGptInput(signal: AbortSignal): Promise<Model<Api>['input']> {
  if (!connectedGptEnabled()) throw new ProviderError('connection_not_enabled', 'Connected GPT has not been enabled by the person running this lab.', 403);
  if (hostedFreeOnly()) return labModel('openai-codex', CONNECTED_GPT_MODEL).input;
  signal.throwIfAborted();
  if (cachedConnectedGptInput && Date.now() - cachedConnectedGptInput.at < 300_000) return cachedConnectedGptInput.input;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('omp', ['models', 'find', CONNECTED_GPT_MODEL, '--json', '--no-extensions'], {
      timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, signal,
    }));
  } catch {
    if (signal.aborted) throw signal.reason;
    return ['text'];
  }
  let models: unknown;
  try {
    models = JSON.parse(stdout);
  } catch {
    return ['text'];
  }
  const rows = z.object({ models: z.array(z.unknown()) }).safeParse(models);
  if (!rows.success) return ['text'];
  const matches = rows.data.models.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null
    && 'provider' in row && row.provider === 'openai-codex' && 'id' in row && row.id === CONNECTED_GPT_MODEL);
  if (matches.length !== 1) return ['text'];
  const model = ConnectedGptModelSchema.safeParse(matches[0]);
  const input: Model<Api>['input'] = model.success
    ? model.data.input.filter((modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image')
    : ['text'];
  cachedConnectedGptInput = { at: Date.now(), input };
  return input;
}
export async function resolveLabModel(provider: Provider, id: string, signal: AbortSignal): Promise<Model<Api>> {
  signal.throwIfAborted();
  const model = labModel(provider, id);
  if (provider === 'openrouter') {
    let catalog: OpenRouterCatalog;
    try {
      catalog = await openRouterCatalog(signal);
    } catch {
      if (signal.aborted) throw signal.reason;
      if (hostedFreeOnly()) throw new ProviderError('provider_unavailable', 'The free model catalog could not be checked. Please try again shortly.', 503);
      return { ...model, input: ['text'] };
    }
    if (hostedFreeOnly() && !catalog.models.some(option => option.id === id && option.free)) {
      throw new ProviderError('unsupported_model', 'Choose an available free model from AI settings.', 400);
    }
    const textInput = catalog.imageInputs.get(id);
    return { ...model, input: textInput === undefined ? ['text'] : textInput ? ['text', 'image'] : ['image'] };
  }
  if (provider === 'openai-codex') return { ...model, input: await connectedGptInput(signal) };
  return model;
}

const ProviderStreamFailureSchema = z.object({
  type: z.enum(['error', 'response.failed']),
  error: z.object({ code: z.string().optional(), type: z.string().optional() }).optional(),
  response: z.object({ error: z.object({ code: z.string().optional(), type: z.string().optional() }).optional() }).optional(),
});


export async function streamLabModel(provider: Provider, model: Model<Api>, context: TranscriptContext, signal: AbortSignal, emit: (event: AssistantMessageEvent) => void, credential?: string, requiredTool?: 'submit_review' | 'any'): Promise<void> {
  enforceHostedModel(provider, model.id);
  if (requiredTool) {
    const tools = getCurrentTools(context.messages);
    if (tools.length === 0 || (requiredTool !== 'any' && (tools.length !== 1 || tools[0]?.name !== requiredTool))) {
      throw new ProviderError('required_tool_unavailable', 'The required lab tool is not active for this model request.', 502);
    }
  }
  const key = credential ?? await providerKey(provider, signal);
  let status = 0;
  let bytes = 0;
  let oversized = false;
  let overloaded = false;
  const demo = provider === 'openai-codex' ? hostedDemo() : null;
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(120_000, demo ? demo.deadline - Date.now() : 120_000)))]);
  const stream = adapters[provider].streamSimple(model, context, {
    apiKey: key, signal: timeout, maxTokens: 8192, timeoutMs: 120_000, maxRetries: 0,
    transport: 'sse', ...(provider === 'openai-codex' ? { reasoning: 'high' as const } : provider === 'openrouter' && model.reasoning ? { reasoning: 'low' as const } : {}),
    onProviderStreamEvent: value => {
      if (typeof value !== 'object' || value === null || !('type' in value) || (value.type !== 'error' && value.type !== 'response.failed')) return;
      const parsed = ProviderStreamFailureSchema.safeParse(value);
      if (!parsed.success) return;
      const error = parsed.data.error ?? parsed.data.response?.error;
      overloaded ||= error?.code === 'server_is_overloaded' || error?.type === 'service_unavailable_error';
    },
    fetch: async (input, init) => {
      const target = input instanceof Request ? input.url : String(input);
      const allowed = `${ENDPOINTS[provider]}${provider === 'openai-codex' ? '/codex/responses' : provider === 'openai' ? '/responses' : provider === 'anthropic' ? '/v1/messages?beta=true' : '/chat/completions'}`;
      if (target !== allowed) throw new Error('Provider request denied by the lab broker.');
      const response = await fetch(input, { ...init, signal: timeout, redirect: 'error' });
      status = response.status;
      let received = 0;
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          // SSE repeats envelope metadata; generated deltas retain their separate 512 KiB limit.
          if (received > 16 * 1024 * 1024) {
            oversized = true;
            controller.error(new Error('Provider response exceeded the lab limit.'));
          } else controller.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    onPayload: payload => {
      let request = payload;
      if (requiredTool) {
        if (typeof request !== 'object' || request === null || Array.isArray(request)) {
          throw new ProviderError('provider_request_invalid', 'The provider SDK did not produce a valid model request.', 502);
        }
        const toolChoice = requiredTool === 'any' || provider === 'openrouter'
          ? provider === 'anthropic' ? { type: 'any' } : 'required'
          : provider === 'anthropic' ? { type: 'tool', name: requiredTool } : { type: 'function', name: requiredTool };
        request = { ...request, tool_choice: toolChoice };
      }
      if (provider === 'openrouter' && typeof request === 'object' && request !== null) {
        if (hostedFreeOnly() && (!('model' in request) || request.model !== model.id || 'models' in request)) {
          throw new ProviderError('provider_request_invalid', 'The provider request did not preserve the selected free model.', 502);
        }
        // Keep deliberation bounded where supported; never disable mandatory model reasoning.
        const routed = { ...request } as Record<string, unknown>;
        if (!model.reasoning) delete routed.reasoning;
        routed.provider = { require_parameters: true, ...(hostedFreeOnly() ? { max_price: { prompt: 0, completion: 0 } } : {}) };
        routed.plugins = [];
        return routed;
      }
      return request;
    },
  });
  for await (const event of stream) {
    signal.throwIfAborted();
    if (event.type === 'error') {
      if (oversized) throw new ProviderError('provider_response_too_large', 'The model response exceeded the lab limit.', 502);
      if (status === 429) throw new ProviderError('provider_rate_limited', 'The selected provider is rate-limiting this model. Your draft and current scene are preserved.', 429);
      if (status === 401 || status === 403) throw new ProviderError('provider_authentication_failed', 'The provider rejected the configured credentials.', 502);
      if (provider === 'openrouter' && status === 404) throw new ProviderError('provider_route_unavailable', 'OpenRouter has no eligible provider for this model. Check its provider/privacy settings or choose another model. No paid fallback was used.', 503);
      if (status === 400 || status === 422) throw new ProviderError('provider_request_rejected', 'The AI service rejected its request parameters. This is a provider compatibility issue; your experiment is unchanged.', 502);
      if (timeout.aborted) throw new ProviderError('provider_timeout', 'The selected model exceeded its 120-second response deadline.', 504);
      if (overloaded || status >= 500) throw new ProviderError('provider_busy', 'The selected AI service is temporarily overloaded. Your request and previous experiment are preserved; changing the physics request will not fix this.', 503);
      throw new ProviderError('provider_unavailable', 'The selected AI service stopped before completing this turn. Your request and previous experiment are preserved.', 502);
    }
    if (event.type === 'done' && (event.reason === 'length' || event.reason === 'deferred')) throw new ProviderError('invalid_provider_response', 'The model did not complete its response within the supported output budget.', 502);
    // Count generated deltas, not the SDK's repeated full partial-message snapshots.
    if ('delta' in event) bytes += Buffer.byteLength(event.delta);
    if (bytes > 512 * 1024) throw new ProviderError('provider_response_too_large', 'The model response exceeded the lab limit.', 502);
    emit(event);
  }
}

const CatalogModelSchema = z.object({
  id: HarnessRequestSchema.shape.model, name: z.string().optional(),
  architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }),
  supported_parameters: z.array(z.string()).optional(), context_length: z.number().positive().nullable().optional(),
});
const CatalogSchema = z.object({ data: z.array(z.unknown()) });
async function openRouterCatalog(signal?: AbortSignal): Promise<OpenRouterCatalog> {
  signal?.throwIfAborted();
  if (cachedModels && Date.now() - cachedModels.at < 300_000) return cachedModels;
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  let response: Response;
  try { response = await fetch('https://openrouter.ai/api/v1/models', { signal: timeout, redirect: 'error' }); }
  catch {
    if (signal?.aborted) throw signal.reason;
    throw new ProviderError('provider_unavailable', 'The OpenRouter model catalog is unavailable.', 502);
  }
  if (!response.ok || !response.body) throw new ProviderError('provider_unavailable', 'The OpenRouter model catalog is unavailable.', 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new ProviderError('provider_response_too_large', 'The model catalog exceeded its size limit.', 502);
    chunks.push(chunk);
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProviderError('invalid_provider_response', 'The model catalog format is invalid.', 502); }
  const parsed = CatalogSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError('invalid_provider_response', 'The model catalog format is invalid.', 502);
  const models: OpenRouterCatalog['models'] = [];
  const imageInputs = new Map<string, boolean>();
  const declarations = new Map<string, number>();
  const listed = new Set<string>();
  for (const value of parsed.data.data) {
    if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string') {
      const id = value.id.trim();
      if (id && id.length <= 200) declarations.set(id, (declarations.get(id) ?? 0) + 1);
    }
    const row = CatalogModelSchema.safeParse(value);
    if (!row.success) continue;
    const model = row.data;
    const textInput = model.architecture.input_modalities.includes('text');
    if (textInput && model.architecture.input_modalities.includes('image')) imageInputs.set(model.id, true);
    if (!textInput || !model.architecture.output_modalities.includes('text') || !model.supported_parameters?.includes('tools') || listed.has(model.id)) continue;
    listed.add(model.id);
    models.push({ id: model.id, name: model.name || model.id, free: model.id.endsWith(':free') || model.id === 'openrouter/free', contextLength: model.context_length ?? null });
  }
  for (const [id, count] of declarations) if (count !== 1) imageInputs.delete(id);
  if (!listed.has('openrouter/free')) models.unshift({ id: 'openrouter/free', name: 'OpenRouter Free Router', free: true, contextLength: null });
  cachedModels = { at: Date.now(), models, imageInputs };
  return cachedModels;
}
export async function listOpenRouterModels(signal?: AbortSignal): Promise<ModelOption[]> {
  const models = (await openRouterCatalog(signal)).models;
  return hostedFreeOnly() ? models.filter(model => model.free) : models;
}
