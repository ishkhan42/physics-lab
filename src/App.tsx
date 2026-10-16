import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ZodError } from 'zod';
import { MODEL_NOTES, PROVIDER_LABELS, type ModelOption, type ProviderConfig } from '../shared/catalog.ts';
import { AssemblyRequestSchema, validateDecision, type AssemblyRequest, type Decision, type Provider } from '../shared/scene.ts';
import ObjectCards from './ObjectCards.tsx';
import SimulationCanvas, { type CanvasExperiment } from './SimulationCanvas.tsx';
import type { InspectionSnapshot } from './physics/types.ts';



type Flow = {
  kind: 'idle' | 'requesting' | 'clarification' | 'preparing' | 'ready' | 'unsupported' | 'error';
  message: string;
};

const OPENROUTER_FREE_ROUTE: ModelOption = {
  id: 'openrouter/free',
  name: 'OpenRouter free route',
  free: true,
  structuredOutputs: false,
  contextLength: null,
};
const PROVIDER_IDS = Object.keys(PROVIDER_LABELS) as Provider[];
const PROMPT_STARTERS = [
  {
    label: 'Falling objects',
    prompt: 'Drop two spheres of radius 0.15 m, with masses 1 kg and 2 kg, from rest at the same centre height of 5 m, 2 m apart. The 1 kg sphere is elastic (restitution 1); the 2 kg sphere is inelastic (restitution 0). Use gravity [0, 0, -9.81] m/s² and no air resistance. Use the built-in ground at z = 0 with restitution 1 and zero friction. Compare their falls and rebounds.',
  },
  {
    label: 'A collision',
    prompt: 'Two spheres of radius 0.2 m and masses 1 kg and 2 kg start at [-1, 0, 1] m and [1, 0, 1] m. They move toward each other along x at 1 m/s each with zero spin. Both have restitution 1 and zero friction. Use zero gravity and keep the built-in ground at z = 0. Show collision velocities, linear momentum and translational kinetic energy.',
  },
  {
    label: 'Spring motion',
    prompt: 'Attach a 1 kg point mass to a fixed anchor at the origin with a massless spring of rest length 1 m and stiffness 10 N/m, with zero damping and zero gravity. Start the mass at (2, 0, 0) m at rest and constrain it to move along the x-axis. Show its motion and the spring force.',
  },
] as const;



function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, value);
}

function parseProviderConfig(value: unknown): ProviderConfig {
  if (typeof value !== 'object' || value === null || !('providers' in value) || !Array.isArray(value.providers)) {
    throw new Error('The API returned an invalid provider configuration.');
  }
  const providerEntries: unknown[] = value.providers;
  const providers = PROVIDER_IDS.map(id => {
    const entry = providerEntries.find(candidate => typeof candidate === 'object' && candidate !== null && 'id' in candidate && candidate.id === id);
    return { id, label: PROVIDER_LABELS[id], available: typeof entry === 'object' && entry !== null && 'available' in entry && entry.available === true };
  });
  return {
    providers,
    defaultProvider: 'defaultProvider' in value && isProvider(value.defaultProvider) ? value.defaultProvider : null,
    defaultModel: 'defaultModel' in value && typeof value.defaultModel === 'string' ? value.defaultModel : null,
  };
}

function parseModels(value: unknown): ModelOption[] {
  if (typeof value !== 'object' || value === null || !('models' in value) || !Array.isArray(value.models)) {
    throw new Error('The API returned an invalid OpenRouter model list.');
  }
  return value.models.filter((candidate): candidate is ModelOption => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    return 'id' in candidate
      && typeof candidate.id === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(candidate.id)
      && 'name' in candidate
      && typeof candidate.name === 'string'
      && 'free' in candidate
      && typeof candidate.free === 'boolean'
      && 'structuredOutputs' in candidate
      && typeof candidate.structuredOutputs === 'boolean'
      && 'contextLength' in candidate
      && (candidate.contextLength === null || (typeof candidate.contextLength === 'number' && Number.isFinite(candidate.contextLength)));
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.slice(0, 4).map(issue => {
      const path = issue.path.length ? issue.path.join('.') : 'response';
      return `${path}: ${issue.message}`;
    }).join(' ');
  }
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

function responseError(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    if ('error' in payload) {
      const error = payload.error;
      if (typeof error === 'string') return error;
      if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
    }
    if ('message' in payload && typeof payload.message === 'string') return payload.message;
  }
  return `The local API returned HTTP ${status}.`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}



export default function App() {
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [provider, setProvider] = useState<Provider | ''>('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [freeModel, setFreeModel] = useState(OPENROUTER_FREE_ROUTE.id);
  const [modelInput, setModelInput] = useState('');
  const [description, setDescription] = useState('');
  const [clarifications, setClarifications] = useState<{ question: string; answer: string }[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [responseDecision, setResponseDecision] = useState<Decision | null>(null);
  const [flow, setFlow] = useState<Flow>({ kind: 'idle', message: '' });
  const [activeExperiment, setActiveExperiment] = useState<CanvasExperiment | null>(null);
  const [pendingExperiment, setPendingExperiment] = useState<CanvasExperiment | null>(null);
  const [snapshot, setSnapshot] = useState<InspectionSnapshot | null>(null);
  const [formError, setFormError] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const requestStartedAt = useRef(0);
  const progressRef = useRef<HTMLDivElement>(null);
  const responseRef = useRef<HTMLElement>(null);
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const candidateRef = useRef<CanvasExperiment | null>(null);
  const activeRef = useRef<CanvasExperiment | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (question && flow.kind === 'clarification') answerRef.current?.focus();
  }, [flow.kind, question]);


  activeRef.current = activeExperiment;
  candidateRef.current = pendingExperiment;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/config', { signal: controller.signal });
        const payload: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(responseError(payload, response.status));
        const nextConfig = parseProviderConfig(payload);
        setConfig(nextConfig);
        const available = nextConfig.providers.filter(item => item.available);
        const initialProvider = nextConfig.defaultProvider && available.some(item => item.id === nextConfig.defaultProvider)
          ? nextConfig.defaultProvider
          : available[0]?.id ?? '';
        setProvider(initialProvider);
      } catch (error) {
        if (!isAbortError(error)) setConfigError(errorMessage(error));
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (provider !== 'openrouter') {
      setModels([]);
      setModelsError('');
      setModelsLoading(false);
      return;
    }
    const controller = new AbortController();
    setModelsLoading(true);
    setModelsError('');
    void (async () => {
      try {
        const response = await fetch('/api/models?provider=openrouter', { signal: controller.signal });
        const payload: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(responseError(payload, response.status));
        const currentModels = parseModels(payload);
        setModels(currentModels);
        setFreeModel(current => {
          const configuredFree = config?.defaultProvider === 'openrouter'
            ? currentModels.find(item => item.id === config.defaultModel && item.free)?.id
            : undefined;
          if (configuredFree) return configuredFree;
          return current === OPENROUTER_FREE_ROUTE.id || currentModels.some(item => item.id === current && item.free)
            ? current
            : OPENROUTER_FREE_ROUTE.id;
        });
      } catch (error) {
        if (!isAbortError(error)) {
          setModels([]);
          setModelsError(errorMessage(error));
        }
      } finally {
        if (!controller.signal.aborted) setModelsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [provider, config]);

  useEffect(() => () => {
    generation.current += 1;
    requestController.current?.abort();
  }, []);

  const invalidateWork = useCallback((message = 'The draft changed. Its previous request or preparation was canceled.') => {
    const wasWorking = requestController.current !== null || candidateRef.current !== null;
    generation.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    candidateRef.current = null;
    setPendingExperiment(null);
    setFlow({ kind: 'idle', message: wasWorking ? message : '' });
  }, []);


  const handleDescriptionChange = (value: string) => {
    if (value !== description) {
      invalidateWork();
      setClarifications([]);
      setQuestion('');
      setAnswer('');
      setResponseDecision(null);
      setFormError('');
    }
    setDescription(value);
  };

  const handleProviderChange = (value: string) => {
    invalidateWork();
    setProvider(isProvider(value) ? value : '');
    setFreeModel(OPENROUTER_FREE_ROUTE.id);
    setModelInput('');
    setFormError('');
  };

  const handleModelInput = (value: string) => {
    invalidateWork();
    setModelInput(value);
    if (provider === 'openrouter') setFreeModel('');
    setFormError('');
  };

  const selectedModel = provider === 'openrouter' ? modelInput.trim() || freeModel : modelInput.trim();
  const selectedProviderLabel = config?.providers.find(item => item.id === provider)?.label
    ?? (provider ? PROVIDER_LABELS[provider] : 'Choose provider and model');
  const availableProviders = config?.providers.filter(item => item.available) ?? [];
  const isBusy = flow.kind === 'requesting' || flow.kind === 'preparing';

  useEffect(() => {
    if (!isBusy) return;
    progressRef.current?.scrollIntoView({ block: 'start' });
    progressRef.current?.focus({ preventScroll: true });
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((performance.now() - requestStartedAt.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isBusy]);

  useEffect(() => {
    if (flow.kind === 'unsupported') {
      responseRef.current?.scrollIntoView({ block: 'nearest' });
      responseRef.current?.focus({ preventScroll: true });
    }
  }, [flow.kind]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBusy) return;
    const clarification = question
      ? [...clarifications, { question, answer: answer.trim() }]
      : clarifications;
    let request: AssemblyRequest;
    try {
      request = AssemblyRequestSchema.parse({
        provider,
        model: selectedModel,
        description,
        clarification,
      });
    } catch (error) {
      setFormError(errorMessage(error));
      return;
    }

    const id = ++generation.current;
    const controller = new AbortController();
    requestController.current = controller;
    requestStartedAt.current = performance.now();
    setElapsedSeconds(0);
    setFormError('');
    setResponseDecision(null);
    setFlow({ kind: 'requesting', message: `Sending this description to ${PROVIDER_LABELS[request.provider]} using ${request.model}.` });
    try {
      const response = await fetch('/api/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (id !== generation.current) return;
      if (!response.ok) throw new Error(responseError(payload, response.status));
      const decision = validateDecision(payload);
      if (id !== generation.current) return;
      requestController.current = null;
      if (question) setClarifications(clarification);

      if (decision.kind === 'clarify') {
        setResponseDecision(decision);
        setQuestion(decision.question ?? '');
        setAnswer('');
        setFlow({ kind: 'clarification', message: 'One consequential detail is needed before this experiment can be assembled.' });
      } else if (decision.kind === 'unsupported') {
        setResponseDecision(decision);
        setQuestion(decision.question ?? '');
        setAnswer('');
        setFlow({ kind: 'unsupported', message: 'No replacement scene was created. The current preview, if any, is unchanged.' });
      } else if (decision.scene) {
        const experiment: CanvasExperiment = { id, scene: decision.scene, decision };
        candidateRef.current = experiment;
        setPendingExperiment(experiment);
        setQuestion('');
        setAnswer('');
        setFlow({ kind: 'preparing', message: 'The returned scene is being compiled into a paused physics preview.' });
      } else {
        throw new Error('The validated scene decision did not contain a scene.');
      }
    } catch (error) {
      if (id !== generation.current || isAbortError(error)) return;
      requestController.current = null;
      setFlow({ kind: 'error', message: `Assembly failed. ${errorMessage(error)} The prompt and current preview are preserved.` });
    } finally {
      if (id === generation.current && requestController.current === controller) requestController.current = null;
    }
  };

  const handleCanvasStatus = useCallback((id: number, message: string) => {
    if (id === generation.current) setFlow({ kind: 'preparing', message });
  }, []);

  const handleCanvasReady = useCallback((experiment: CanvasExperiment, nextSnapshot: InspectionSnapshot) => {
    if (experiment.id !== generation.current) return;
    activeRef.current = experiment;
    candidateRef.current = null;
    setActiveExperiment(experiment);
    setPendingExperiment(current => current?.id === experiment.id ? null : current);
    setSnapshot(nextSnapshot);
    setResponseDecision(null);
    setFlow({ kind: 'ready', message: 'Physics preview ready. Use the controls below to run or pause the solver.' });
  }, []);

  const handleCanvasSnapshot = useCallback((id: number, nextSnapshot: InspectionSnapshot) => {
    if (activeRef.current?.id === id) setSnapshot(nextSnapshot);
  }, []);

  const handleCanvasFailure = useCallback((id: number, message: string) => {
    if (id !== generation.current) return;
    candidateRef.current = null;
    setPendingExperiment(current => current?.id === id ? null : current);
    const preservation = activeRef.current ? 'The previous preview is unchanged.' : 'Your prompt is unchanged.';
    setFlow({ kind: 'error', message: `The replacement preview could not be prepared: ${message} ${preservation}` });
  }, []);

  const interpretation = activeExperiment?.decision ?? null;
  const noProvidersAvailable = config !== null && availableProviders.length === 0;
  const canSubmit = !isBusy && !configError && provider !== '' && selectedModel.length > 0 && description.trim().length >= 3;
  const settingsSummary = provider
    ? `${selectedProviderLabel} · ${selectedModel || 'model not selected'}`
    : 'Choose provider and model';


  return (
    <div className="lab-shell">
      <header className="topbar">
        <a className="lab-mark" href="#main" aria-label="Mission Board home">
          <span className="lab-mark__glyph" aria-hidden="true">M</span>
          <span><strong>PHYSICS LAB</strong><small>MISSION BOARD</small></span>
        </a>
        <div className="service-state" aria-live="polite">
          <span className={`service-state__signal ${config && !configError ? 'is-live' : ''}`} aria-hidden="true" />
          {configError ? 'API unavailable' : config ? 'Local API connected' : 'Connecting to local API'}
        </div>
      </header>

      <main id="main" className="mission-board">
        <section className="setup-panel glass-panel" aria-labelledby="setup-title">
          <div className="setup-heading">
            <div>
              <p className="eyebrow">Experiment workspace</p>
              <h1 id="setup-title">Build a mechanics preview</h1>
            </div>
            <span className="category-stamp">CLASSICAL · SI UNITS</span>
          </div>

          <form className="assembly-form" onSubmit={handleSubmit}>
            <label className="field description-field">
              <span className="field-label">Describe your experiment</span>
              <textarea
                ref={descriptionRef}
                value={description}
                onChange={event => handleDescriptionChange(event.target.value)}
                placeholder="What is moving or touching? Include masses, heights, initial speeds, and contacts."
                minLength={3}
                maxLength={16000}
                required
                rows={4}
                aria-describedby="description-hint"
              />
              <span className="field-hint" id="description-hint">Describe what you know. We’ll ask about missing details or explicitly list the sensible defaults used.</span>
            </label>

            <div className="prompt-starters" role="group" aria-label="Fill the editable prompt with a starter">
              <span className="field-label">Start with</span>
              <div className="prompt-starters__buttons">
                {PROMPT_STARTERS.map(starter => (
                  <button
                    className="starter-button"
                    type="button"
                    key={starter.label}
                    onClick={() => {
                      handleDescriptionChange(starter.prompt);
                      descriptionRef.current?.focus();
                    }}
                  >
                    {starter.label}
                  </button>
                ))}
              </div>
            </div>

            <details className="settings-details">
              <summary className="settings-summary">
                <span className="settings-summary__title">Model settings</span>
                <span className="settings-summary__selection">{settingsSummary}</span>
              </summary>
              <div className="settings-content">
                <p className="settings-intro">These choices apply when you assemble. Changing settings never sends an assembly request.</p>
                <div className="provider-fields">
                  <label className="field">
                    <span className="field-label">Model provider</span>
                    <select
                      value={provider}
                      onChange={event => handleProviderChange(event.target.value)}
                      disabled={!config || availableProviders.length === 0 || isBusy}
                      required
                    >
                      <option value="" disabled>{config ? 'Choose a configured provider' : 'Loading providers…'}</option>
                      {config?.providers.map(item => (
                        <option value={item.id} disabled={!item.available} key={item.id}>
                          {item.label}{item.available ? '' : ' · not configured'}
                        </option>
                      ))}
                    </select>
                  </label>

                  {provider === 'openrouter' ? (
                    <>
                      <label className="field">
                        <span className="field-label">OpenRouter free model</span>
                        <select
                          value={freeModel}
                          onChange={event => { invalidateWork(); setFreeModel(event.target.value); setModelInput(''); }}
                          disabled={isBusy}
                        >
                          <option value="" disabled>Choose a free route or enter a model ID</option>
                          {[OPENROUTER_FREE_ROUTE, ...models.filter(item => item.free && item.id !== OPENROUTER_FREE_ROUTE.id)].map(item => (
                            <option value={item.id} key={item.id}>{`${item.name} · ${item.id} · free`}</option>
                          ))}
                        </select>
                        <span className="field-hint">Free routes can have changing quotas and availability.</span>
                      </label>
                      <label className="field">
                        <span className="field-label">Or enter another current model ID</span>
                        <input
                          value={modelInput}
                          onChange={event => handleModelInput(event.target.value)}
                          list="openrouter-model-list"
                          maxLength={200}
                          placeholder="Search current model IDs or enter one"
                          disabled={isBusy}
                        />
                        <datalist id="openrouter-model-list">
                          {models.map(item => <option value={item.id} label={item.name} key={item.id} />)}
                        </datalist>
                        <span className="field-hint field-hint--warning">Custom model IDs may cost money. Check the route’s current pricing.</span>
                      </label>
                    </>
                  ) : (
                    <label className="field">
                      <span className="field-label">Model ID</span>
                      <input
                        value={modelInput}
                        onChange={event => handleModelInput(event.target.value)}
                        maxLength={200}
                        placeholder="Enter a current provider model ID"
                        disabled={!provider || isBusy}
                        required
                      />
                      <span className="field-hint field-hint--warning">Custom model IDs may incur charges. Check your provider’s current pricing.</span>
                    </label>
                  )}
                </div>

                {provider === 'openrouter' && modelsLoading ? <p className="inline-note">Loading the current OpenRouter catalog…</p> : null}
                {provider === 'openrouter' && modelsError ? (
                  <p className="inline-note inline-note--warning" role="status">Current model suggestions could not be loaded. The free route remains selectable, and you can enter another model ID.</p>
                ) : null}

                <div className="category-row">
                  <label className="field category-field">
                    <span className="field-label">Physics category</span>
                    <select defaultValue="mechanics" aria-label="Physics category">
                      <option value="mechanics">Mechanics</option>
                    </select>
                  </label>
                  <p className="category-description">Only mechanics is active in this lab.</p>
                </div>
              </div>
            </details>

            {question ? (
              <div className="clarification-panel" aria-labelledby="clarification-question">
                <span className="field-label">One detail before assembly</span>
                <p id="clarification-question">{question}</p>
                <label className="field">
                  <span className="field-label">Your answer</span>
                  <textarea
                    ref={answerRef}
                    value={answer}
                    onChange={event => setAnswer(event.target.value)}
                    maxLength={4000}
                    required
                    rows={2}
                    placeholder="Add the missing condition without rewriting your scenario."
                  />
                </label>
              </div>
            ) : null}

            {configError ? (
              <div className="notice notice--error" role="alert">
                <strong>Local API is unavailable.</strong> {configError} Start the API with <code>npm run api</code>, then reload this page.
              </div>
            ) : null}
            {noProvidersAvailable ? (
              <div className="notice notice--warning" role="status">
                <strong>No provider key is configured.</strong> Set <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, or <code>OPENROUTER_API_KEY</code> in a private server-side environment file, such as an ignored local <code>.env</code>, and restart the API. Keep the file outside public assets; never use a <code>VITE_</code> key.
              </div>
            ) : null}
            {formError ? <div className="notice notice--error" role="alert">{formError}</div> : null}

            <div className="submit-row">
              <div className="submit-actions">
                <button className="primary-button" type="submit" disabled={!canSubmit || (question !== '' && answer.trim().length === 0)}>
                  {flow.kind === 'requesting' ? 'Waiting for model…' : flow.kind === 'preparing' ? 'Preparing preview…' : question ? 'Answer and continue' : 'Assemble scene'}
                </button>
              </div>
              <p className="privacy-note">The selected provider receives your scenario and clarification replies. API keys stay on the local server.</p>
            </div>
          </form>

          {flow.message && !isBusy && flow.kind !== 'unsupported' && flow.kind !== 'clarification' ? (
            <div className={`flow-message flow-message--${flow.kind}`} role={flow.kind === 'error' ? 'alert' : 'status'} aria-live={flow.kind === 'error' ? 'assertive' : 'polite'} aria-busy={isBusy}>
              <span className="flow-message__line" aria-hidden="true" />
              <div className="flow-message__content">
                <p>{flow.message}</p>
                {flow.kind === 'ready' ? <p className="flow-message__next">Review the model summary and assumptions, then run the preview when they match your intent.</p> : null}
                {flow.kind === 'error' ? <p className="flow-message__next">Check the provider or model settings, or refine the prompt, then assemble again. No request is retried automatically.</p> : null}
              </div>
            </div>
          ) : null}

          {responseDecision && (responseDecision.kind === 'unsupported' || responseDecision.alternative) ? (
            <section className="response-panel response-panel--unsupported" ref={responseRef} tabIndex={-1} aria-labelledby="response-title">
              <h2 id="response-title">{responseDecision.kind === 'unsupported' ? 'Let’s adjust this experiment' : 'Another way to try this'}</h2>
              <p>{responseDecision.summary}</p>
              {responseDecision.alternative ? (
                <div className="response-proposal">
                  <h3>{responseDecision.alternative.label}</h3>
                  <p>{responseDecision.alternative.description}</p>
                  <button className="primary-button" type="button" onClick={() => {
                    handleDescriptionChange(responseDecision.alternative!.description);
                    descriptionRef.current?.focus();
                  }}>Use this setup</button>
                  <small>Fills your draft for review. Nothing is built until you press Assemble.</small>
                </div>
              ) : null}
              <div className="response-panel__actions">
                <button className="secondary-button" type="button" onClick={() => descriptionRef.current?.focus()}>Edit my request</button>
              </div>
              {responseDecision.reason ? (
                <details className="response-details">
                  <summary>Why this needs a change</summary>
                  <p>{responseDecision.reason}</p>
                </details>
              ) : null}
              <p className="field-hint">{activeExperiment ? 'Your existing experiment is unchanged.' : 'No simulation has been created.'}</p>
            </section>
          ) : null}

          {interpretation ? (
            <aside className={`interpretation-panel${responseDecision ? ' interpretation-panel--preserved' : ''}`} aria-label="Preview interpretation">
              <div className="interpretation-heading">
                <span className="eyebrow">{responseDecision ? 'Unchanged preview' : 'Current preview'}</span>
              </div>
              <p>{interpretation.summary}</p>
              <p className="interpretation-guide">This is the scene currently shown. Editing your draft does not change it.</p>
              <div className="assumed-defaults">
                <strong>Assumed defaults and idealizations</strong>
                <p>Check any values you didn’t specify before pressing Run. Initial values for every object are shown below the canvas.</p>
                {interpretation.scene?.ground ? (
                  <p>Physical ground: z = {interpretation.scene.ground.height} m; target restitution {interpretation.scene.ground.restitution}; static friction {interpretation.scene.ground.friction.static ?? interpretation.scene.ground.friction.sliding}, sliding friction {interpretation.scene.ground.friction.sliding}.</p>
                ) : <p>Built-in ground is explicitly disabled. Any separately modeled surfaces are listed in the object cards.</p>}
                {interpretation.assumptions.length > 0 ? (
                  <ul>{interpretation.assumptions.map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}</ul>
                ) : <p>No additional physical assumptions were reported by the model. Verify the interpreted setup against your description.</p>}
              </div>
            </aside>
          ) : null}

          <details className="capabilities-details">
            <summary>What this lab can model</summary>
            <div className="capabilities-copy">
              <p>Classical mechanics with rigid bodies and point particles, gravity and applied loads, collisions and contacts, joints, and cable or spring connections.</p>
              <p>Contacts include elastic, partially elastic and inelastic restitution targets, static and kinetic sliding friction, and torsional/rolling resistance. Pair restitution uses the lower coefficient; pair friction uses the higher. Ground is a real physical surface by default.</p>
              <p><strong>Model boundaries:</strong> rigid bodies and compliant numerical contacts, not deformation or fluid fields. Material coefficients are numerical targets with finite-step error; inspect the declared assumptions and actual results.</p>
            </div>
          </details>
        </section>

        <section className="simulation-section" aria-labelledby="simulation-title">
          <div className="section-heading simulation-heading">
            <div>
              <p className="eyebrow">Preview and playback</p>
              <h2 id="simulation-title">Simulation canvas</h2>
            </div>
            <span className="simulation-unit">Z-up · metres · seconds</span>
          </div>
          {isBusy ? (
            <div className="assembly-progress" data-stage={flow.kind} role="status" aria-live="polite" ref={progressRef} tabIndex={-1}>
              <div className="assembly-progress__heading">
                <strong>{flow.kind === 'requesting' ? 'Interpreting your experiment' : 'Building your simulation'}</strong>
                <output aria-label="Elapsed assembly time" aria-live="off">{elapsedSeconds}s elapsed</output>
              </div>
              <div className="assembly-progress__track" role="progressbar" aria-label="Assembly in progress" aria-valuetext={flow.kind === 'requesting' ? 'Waiting for the selected provider' : flow.message}><span /></div>
              <ol className="assembly-progress__steps">
                <li data-state={flow.kind === 'requesting' ? 'active' : 'done'} aria-current={flow.kind === 'requesting' ? 'step' : undefined}>Interpret request</li>
                <li data-state={flow.kind === 'preparing' ? 'active' : 'pending'} aria-current={flow.kind === 'preparing' ? 'step' : undefined}>Build model</li>
              </ol>
              <p>{flow.kind === 'requesting'
                ? `Waiting for ${selectedProviderLabel} to return a scene or a question. No simulation is running yet.`
                : flow.message}</p>
              {flow.kind === 'requesting' && elapsedSeconds >= 15 ? <p>The provider is still responding. You can stop waiting without losing your draft or current experiment.</p> : null}
              <button className="secondary-button" type="button" onClick={() => {
                invalidateWork('Stopped waiting. Your prompt and current preview are unchanged. The provider may continue processing; charges may still apply.');
                descriptionRef.current?.focus();
              }}>Stop waiting</button>
            </div>
          ) : null}
          <SimulationCanvas
            experiment={pendingExperiment}
            replacementPending={isBusy}
            onStatus={handleCanvasStatus}
            onReady={handleCanvasReady}
            onSnapshot={handleCanvasSnapshot}
            onFailure={handleCanvasFailure}
          />
        </section>

        <ObjectCards snapshot={snapshot} hasExperiment={activeExperiment !== null || pendingExperiment !== null} />

        <aside className="lab-notes" aria-label="Model notes">
          {MODEL_NOTES.map(note => <span key={note}>{note}</span>)}
        </aside>
      </main>
      <footer className="page-footer">
        <span>Mechanics only</span>
        <span>Read-only inspection · local solver · no generated results</span>
      </footer>
    </div>
  );
}

