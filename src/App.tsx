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
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const candidateRef = useRef<CanvasExperiment | null>(null);
  const activeRef = useRef<CanvasExperiment | null>(null);

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

  const invalidateWork = useCallback(() => {
    const wasWorking = requestController.current !== null || candidateRef.current !== null;
    generation.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    candidateRef.current = null;
    setPendingExperiment(null);
    if (wasWorking) setFlow({ kind: 'idle', message: 'The draft changed. Its previous request or preparation was canceled.' });
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
  const availableProviders = config?.providers.filter(item => item.available) ?? [];
  const isBusy = flow.kind === 'requesting' || flow.kind === 'preparing';

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
        setQuestion('');
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

  const interpretation = responseDecision ?? activeExperiment?.decision ?? null;
  const noProvidersAvailable = config !== null && availableProviders.length === 0;
  const canSubmit = !isBusy && !configError && provider !== '' && selectedModel.length > 0 && description.trim().length >= 3;

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
              <h1 id="setup-title">Describe the mechanics.</h1>
            </div>
            <span className="category-stamp">CLASSICAL · SI UNITS</span>
          </div>

          <form className="assembly-form" onSubmit={handleSubmit}>
            <label className="field description-field">
              <span className="field-label">Scenario</span>
              <textarea
                value={description}
                onChange={event => handleDescriptionChange(event.target.value)}
                placeholder="Describe the setup, what you want to know, and any known conditions."
                minLength={3}
                maxLength={16000}
                required
                rows={4}
                aria-describedby="description-hint"
              />
              <span className="field-hint" id="description-hint">Use your own experiment description. No sample scene is loaded.</span>
            </label>

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
                    <span className="field-hint">Free routes can still have changing quotas and availability.</span>
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
              <p className="category-description">Only mechanics is active in this lab. Other physics categories are not offered as working choices.</p>
            </div>

            {question ? (
              <div className="clarification-panel" aria-labelledby="clarification-question">
                <span className="field-label">One detail before assembly</span>
                <p id="clarification-question">{question}</p>
                <label className="field">
                  <span className="field-label">Your answer</span>
                  <textarea
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
              <button className="primary-button" type="submit" disabled={!canSubmit || (question !== '' && answer.trim().length === 0)}>
                {flow.kind === 'requesting' ? 'Waiting for model…' : flow.kind === 'preparing' ? 'Preparing preview…' : question ? 'Answer and continue' : 'Assemble scene'}
              </button>
              <p className="privacy-note">The selected provider receives your scenario and clarification replies. API keys remain on the local server.</p>
            </div>
          </form>

          {flow.message ? (
            <div className={`flow-message flow-message--${flow.kind}`} role={flow.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
              <span className="flow-message__line" aria-hidden="true" />
              <p>{flow.message}</p>
            </div>
          ) : null}

          {interpretation ? (
            <aside className="interpretation-panel" aria-label="Model interpretation">
              <div className="interpretation-heading">
                <span className="eyebrow">{responseDecision ? 'Current response' : 'Preview interpretation'}</span>
                {responseDecision?.kind === 'unsupported' ? <span className="state-label state-label--warning">Unsupported</span> : null}
              </div>
              <p>{interpretation.summary}</p>
              {interpretation.kind === 'unsupported' && interpretation.reason ? <p className="interpretation-reason">{interpretation.reason}</p> : null}
              {interpretation.assumptions.length > 0 ? (
                <div className="assumption-list">
                  <span className="field-label">Assumptions and idealizations</span>
                  <ul>{interpretation.assumptions.map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}</ul>
                </div>
              ) : null}
            </aside>
          ) : null}
        </section>

        <section className="simulation-section" aria-labelledby="simulation-title">
          <div className="section-heading simulation-heading">
            <div>
              <p className="eyebrow">Mechanics playback</p>
              <h2 id="simulation-title">Simulation canvas</h2>
            </div>
            <span className="simulation-unit">Z-up · metres · seconds</span>
          </div>
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
