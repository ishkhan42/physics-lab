import { ArrowRight, Atom, ClockCounterClockwise } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ZodError } from 'zod';
import { PROVIDER_LABELS, type ModelOption, type ProviderConfig } from '../shared/catalog.ts';
import { AssemblyRequestSchema, hasGroundPlane, validateScene, type AssemblyRequest, type Decision, type Provider } from '../shared/scene.ts';
import { SavedSceneIdSchema, type SavedScene, type SavedSceneMetadata, type SceneDocument } from '../shared/saved-scene.ts';
import { readAssemblyResponse, type AssemblyProgress } from '../shared/assembly-stream.ts';
import ObjectCards from './ObjectCards.tsx';
import SimulationCanvas, { type CanvasExperiment } from './SimulationCanvas.tsx';
import SceneLinkBar from './SceneLinkBar.tsx';
import { createSavedScene, forgetRecentScene, getSavedScene, readRecentScenes, rememberRecentScene, renewSavedScene, SavedSceneApiError, type RecentScene } from './saved-scenes.ts';
import TelemetryPanel from './TelemetryPanel.tsx';
import type { InspectionSnapshot } from './physics/types.ts';
type SceneDecision = Extract<Decision, { kind: 'scene' }>;
type SceneUrlMode = 'push' | 'pop' | 'initial';
type SceneOperation = 'idle' | 'saving' | 'loading' | 'renewing';
type SceneBinding = { saved: SavedScene; urlMode: SceneUrlMode; operationToken: number; restorePrompt: boolean };
type PendingSceneSave = { runtimeId: number; document: SceneDocument; mode: 'prepare' | 'copy'; urlMode: SceneUrlMode };
type ActiveSceneBinding = { runtimeId: number; saved: SavedScene };

type Flow = {
  kind: 'idle' | 'requesting' | 'clarification' | 'preparing' | 'ready' | 'unsupported' | 'error';
  message: string;
  detail?: string;
};

const OPENROUTER_FREE_ROUTE: ModelOption = {
  id: 'openrouter/free',
  name: 'Random free router',
  free: true,
  structuredOutputs: true,
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
    prompt: 'Constrain a 1 kg sphere of radius 0.05 m to move along the x-axis at z = 1 m using an ideal slider. Attach it to a fixed anchor at [0, 0, 1] m with a massless spring of rest length 1 m and stiffness 10 N/m. Use zero damping and zero gravity. Start the sphere at [2, 0, 1] m at rest with zero spin and zero friction. Show its motion and the spring force.',
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

function assemblyFailure(error: unknown): { message: string; detail: string } {
  if (error instanceof Error && 'code' in error && ['provider_busy', 'provider_timeout', 'provider_rate_limited'].includes(String(error.code))) {
    return { message: error.message, detail: '' };
  }
  return {
    message: error instanceof ZodError
      ? 'The provider response could not be read as a supported mechanics scene.'
      : 'The assembly request could not be completed.',
    detail: errorMessage(error),
  };
}
function sceneIdFromPath(pathname: string): string | null {
  const match = /^\/scenes\/([^/]+)\/?$/.exec(pathname);
  if (!match || !SavedSceneIdSchema.safeParse(match[1]).success) return null;
  return match[1];
}




export default function App() {
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [configAttempt, setConfigAttempt] = useState(0);
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
  const [savedScene, setSavedScene] = useState<SavedScene | null>(null);
  const [sceneOperation, setSceneOperation] = useState<SceneOperation>(() => window.location.pathname.startsWith('/scenes/') ? 'loading' : 'idle');
  const [sceneError, setSceneError] = useState('');
  const [recentScenes, setRecentScenes] = useState<RecentScene[]>(() => readRecentScenes());
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null);
  const [clearCanvasToken, setClearCanvasToken] = useState(0);
  const [playback, setPlayback] = useState<{ id: number; playing: boolean } | null>(null);
  const [blockedRuntimeId, setBlockedRuntimeId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<InspectionSnapshot | null>(null);
  const [formError, setFormError] = useState('');
  const [formErrorDetail, setFormErrorDetail] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [assemblyProgress, setAssemblyProgress] = useState<AssemblyProgress | null>(null);
  const requestStartedAt = useRef(0);
  const progressRef = useRef<HTMLDivElement>(null);
  const responseRef = useRef<HTMLElement>(null);
  const flowMessageRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const candidateRef = useRef<CanvasExperiment | null>(null);
  const activeRef = useRef<CanvasExperiment | null>(null);
  const activeSavedRef = useRef<ActiveSceneBinding | null>(null);
  const activeSceneUrlRef = useRef<string | null>(null);
  const activeSourcePromptRef = useRef('');
  const pendingSceneBindingsRef = useRef(new Map<number, SceneBinding>());
  const pendingSaveRef = useRef<PendingSceneSave | null>(null);
  const sceneControllerRef = useRef<AbortController | null>(null);
  const operationTokenRef = useRef(0);
  const operationRef = useRef<SceneOperation>(sceneOperation);
  const retryActionRef = useRef<(() => void) | null>(null);
  const playbackRef = useRef<{ id: number; playing: boolean } | null>(null);
  const failedRenewalRef = useRef<number | null>(null);
  const renewalFlightsRef = useRef(new Map<number, Promise<boolean>>());
  const expiryCheckRef = useRef('');
  const clearAfterPauseRef = useRef(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (question && flow.kind === 'clarification') answerRef.current?.focus();
  }, [flow.kind, question]);


  activeRef.current = activeExperiment;
  candidateRef.current = pendingExperiment;

  useEffect(() => {
    setConfigError('');
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
        if (initialProvider === 'openrouter' && nextConfig.defaultModel) setFreeModel(nextConfig.defaultModel);
      } catch (error) {
        if (!isAbortError(error)) setConfigError(errorMessage(error));
      }
    })();
    return () => controller.abort();
  }, [configAttempt]);

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
          if (current === OPENROUTER_FREE_ROUTE.id || currentModels.some(item => item.id === current && item.free)) return current;
          return configuredFree ?? OPENROUTER_FREE_ROUTE.id;
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
    sceneControllerRef.current?.abort();
  }, []);

  const beginSceneOperation = (operation: SceneOperation) => {
    const token = ++operationTokenRef.current;
    operationRef.current = operation;
    setSceneOperation(operation);
    return token;
  };

  const finishSceneOperation = (token: number) => {
    if (operationTokenRef.current !== token) return;
    operationRef.current = 'idle';
    setSceneOperation('idle');
  };

  const invalidateWork = useCallback((message = 'The draft changed. Its previous request or preparation was canceled.') => {
    const wasWorking = requestController.current !== null || candidateRef.current !== null;
    generation.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    candidateRef.current = null;
    setPendingExperiment(null);
    const preserveCopyRetry = pendingSaveRef.current?.mode === 'copy' && sceneControllerRef.current === null;
    if (!preserveCopyRetry && (sceneControllerRef.current || pendingSaveRef.current || pendingSceneBindingsRef.current.size > 0)) {
      sceneControllerRef.current?.abort();
      sceneControllerRef.current = null;
      pendingSaveRef.current = null;
      pendingSceneBindingsRef.current.clear();
      operationTokenRef.current += 1;
      operationRef.current = 'idle';
      setSceneOperation('idle');
      retryActionRef.current = null;
      setSceneError('');
    }
    if (!activeSavedRef.current && activeRef.current) {
      setSceneError('The current setup has no active saved link. Save a new copy to share it.');
    }
    setFlow({ kind: 'idle', message: wasWorking ? message : '' });
  }, []);


  const handleDescriptionChange = (value: string) => {
    if (sceneOperation === 'loading') return;
    if (value !== description) {
      invalidateWork();
      setClarifications([]);
      setQuestion('');
      setAnswer('');
      setResponseDecision(null);
      setFormError('');
      setFormErrorDetail('');
    }
    setDescription(value);
  };

  const handleAnswerChange = (value: string) => {
    if (sceneOperation === 'loading') return;
    if (value !== answer) {
      invalidateWork();
      setFormError('');
      setFormErrorDetail('');
    }
    setAnswer(value);
  };

  const handleProviderChange = (value: string) => {
    if (sceneOperation === 'loading') return;
    invalidateWork();
    setProvider(isProvider(value) ? value : '');
    setFreeModel(config?.defaultProvider === 'openrouter' && config.defaultModel ? config.defaultModel : OPENROUTER_FREE_ROUTE.id);
    setModelInput('');
    setFormError('');
    setFormErrorDetail('');
  };

  const handleModelInput = (value: string) => {
    if (sceneOperation === 'loading') return;
    invalidateWork();
    setModelInput(value);
    if (provider === 'openrouter') setFreeModel('');
    setFormError('');
    setFormErrorDetail('');
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

  useEffect(() => {
    if (flow.kind === 'error') {
      flowMessageRef.current?.scrollIntoView({ block: 'center' });
      flowMessageRef.current?.focus({ preventScroll: true });
    }
  }, [flow.kind]);

  const preparePreview = (
    decision: SceneDecision,
    id: number,
    userGroundChoice?: CanvasExperiment['userGroundChoice'],
    scene = decision.scene,
  ) => {
    if (id !== generation.current) return;
    const experiment: CanvasExperiment = { id, scene, decision, userGroundChoice };
    candidateRef.current = experiment;
    setPendingExperiment(experiment);
    setAssemblyProgress(null);
    requestStartedAt.current = performance.now();
    setElapsedSeconds(0);
    setFlow({ kind: 'preparing', message: 'Building your paused physics preview.' });
  };

  const saveSceneDocument = async (pending: PendingSceneSave) => {
    if (pending.mode === 'prepare' && pending.runtimeId !== generation.current) return;
    if (pending.mode === 'copy' && activeRef.current?.id !== pending.runtimeId) return;
    sceneControllerRef.current?.abort();
    const controller = new AbortController();
    sceneControllerRef.current = controller;
    pendingSaveRef.current = pending;
    const operationToken = beginSceneOperation('saving');
    setSceneError('');
    if (pending.mode === 'prepare') {
      requestStartedAt.current = performance.now();
      setElapsedSeconds(0);
      setAssemblyProgress(null);
      setFlow({ kind: 'preparing', message: 'Saving this scene before building its paused preview.' });
    }
    try {
      const saved = await createSavedScene(pending.document, controller.signal);
      const stillCurrent = pending.mode === 'prepare'
        ? pending.runtimeId === generation.current
        : activeRef.current?.id === pending.runtimeId;
      if (controller.signal.aborted || !stillCurrent) return;
      sceneControllerRef.current = null;
      pendingSaveRef.current = null;
      setRecentScenes(rememberRecentScene(saved.id, saved.document.scene.title, saved.expiresAt));
      if (pending.mode === 'copy') {
        activeSavedRef.current = { runtimeId: pending.runtimeId, saved };
        activeSceneUrlRef.current = saved.id;
        setSavedScene(saved);
        setCurrentSceneId(saved.id);
        setSceneError('');
        retryActionRef.current = null;
        failedRenewalRef.current = null;
        setBlockedRuntimeId(null);
        window.history.pushState(null, '', `/scenes/${saved.id}`);
        finishSceneOperation(operationToken);
        return;
      }
      pendingSceneBindingsRef.current.set(pending.runtimeId, {
        saved,
        urlMode: pending.urlMode,
        operationToken,
        restorePrompt: false,
      });
      preparePreview(saved.document.decision, pending.runtimeId, saved.document.userGroundChoice, saved.document.scene);
    } catch (error) {
      if (controller.signal.aborted || pending.runtimeId !== (pending.mode === 'prepare' ? generation.current : activeRef.current?.id)) return;
      sceneControllerRef.current = null;
      finishSceneOperation(operationToken);
      pendingSaveRef.current = pending;
      setSceneError(`This scene could not be saved. ${errorMessage(error)} Retry the local API without generating the scene again.`);
      retryActionRef.current = () => { void saveSceneDocument(pending); };
      if (pending.mode === 'prepare') {
        setFlow(activeRef.current ? { kind: 'ready', message: 'The existing physics preview is unchanged.' } : { kind: 'idle', message: '' });
      }
    }
  };

  const loadSavedScene = async (id: string, urlMode: SceneUrlMode) => {
    const previousCandidate = candidateRef.current;
    const previousBinding = previousCandidate ? pendingSceneBindingsRef.current.get(previousCandidate.id) : undefined;
    const previousSceneUrlId = activeSavedRef.current?.saved.id ?? activeSceneUrlRef.current;
    if (urlMode !== 'pop' && previousBinding?.urlMode === 'pop' && previousSceneUrlId) {
      window.history.replaceState(null, '', `/scenes/${previousSceneUrlId}`);
    }
    if (pendingSaveRef.current?.mode === 'copy' && sceneControllerRef.current === null) {
      pendingSaveRef.current = null;
      retryActionRef.current = null;
      setSceneError('');
    }
    invalidateWork('Loading a saved scene. The current preview stays available until it is ready.');
    const runtimeId = generation.current;
    const controller = new AbortController();
    sceneControllerRef.current = controller;
    const operationToken = beginSceneOperation('loading');
    setSceneError('');
    retryActionRef.current = () => { void loadSavedScene(id, urlMode === 'initial' ? 'initial' : 'push'); };
    try {
      const saved = await getSavedScene(id, controller.signal);
      if (saved.id !== id) throw new Error('The local API returned a different saved scene.');
      if (controller.signal.aborted || runtimeId !== generation.current) return;
      sceneControllerRef.current = null;
      setRecentScenes(rememberRecentScene(saved.id, saved.document.scene.title, saved.expiresAt));
      pendingSceneBindingsRef.current.set(runtimeId, {
        saved,
        urlMode,
        operationToken,
        restorePrompt: true,
      });
      preparePreview(saved.document.decision, runtimeId, saved.document.userGroundChoice, saved.document.scene);
    } catch (error) {
      if (controller.signal.aborted || runtimeId !== generation.current) return;
      sceneControllerRef.current = null;
      finishSceneOperation(operationToken);
      const unavailable = error instanceof SavedSceneApiError && error.status === 404;
      if (unavailable) setRecentScenes(forgetRecentScene(id));
      const current = activeSavedRef.current;
      if (unavailable && current && current.saved.id === id && activeRef.current?.id === current.runtimeId) {
        activeSavedRef.current = null;
        setSavedScene(null);
        setCurrentSceneId(null);
        failedRenewalRef.current = current.runtimeId;
        setBlockedRuntimeId(current.runtimeId);
        setSceneError('This saved scene expired or is unavailable. Save a new copy of the current setup to create a fresh link.');
        retryActionRef.current = () => { void loadSavedScene(id, 'push'); };
      } else {
        setSceneError(unavailable ? 'This scene link is unavailable or has expired.' : `This saved scene could not be opened. ${errorMessage(error)} Retry the local request.`);
        retryActionRef.current = () => { void loadSavedScene(id, urlMode === 'initial' ? 'initial' : 'push'); };
      }
      const previousSceneUrlId = activeSavedRef.current?.saved.id ?? activeSceneUrlRef.current;
      if (urlMode === 'pop' && previousSceneUrlId) {
        window.history.replaceState(null, '', `/scenes/${previousSceneUrlId}`);
      }
    }
  };

  const loadRecentScene = (item: RecentScene) => {
    void loadSavedScene(item.id, 'push');
  };

  const saveCurrentCopy = () => {
    const current = activeRef.current;
    if (!current || current.decision.kind !== 'scene' || savedScene || pendingSaveRef.current || sceneOperation !== 'idle' || isBusy) return;
    const document: SceneDocument = {
      prompt: activeSourcePromptRef.current,
      decision: current.decision,
      scene: current.scene,
      ...(current.userGroundChoice ? { userGroundChoice: current.userGroundChoice } : {}),
    };
    void saveSceneDocument({ runtimeId: current.id, document, mode: 'copy', urlMode: 'push' });
  };

  const togglePhysicalGround = (include: boolean) => {
    const current = activeRef.current;
    if (!current || current.decision.kind !== 'scene' || isBusy || sceneOperation === 'loading' || sceneOperation === 'saving') return;
    if (pendingSaveRef.current?.mode === 'copy' && sceneControllerRef.current === null) {
      pendingSaveRef.current = null;
      retryActionRef.current = null;
      setSceneError('');
    }
    invalidateWork();
    try {
      const scene = validateScene({ ...current.scene, ground: include ? undefined : null });
      const document: SceneDocument = {
        prompt: activeSourcePromptRef.current,
        decision: current.decision,
        scene,
        userGroundChoice: include ? 'default' : 'none',
      };
      void saveSceneDocument({ runtimeId: generation.current, document, mode: 'prepare', urlMode: 'push' });
    } catch (error) {
      setFlow({ kind: 'error', message: 'This ground choice could not be prepared.', detail: errorMessage(error) });
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBusy || sceneOperation === 'loading' || sceneOperation === 'saving' || pendingSaveRef.current) return;
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
      setFormError('Review the experiment description and model settings.');
      setFormErrorDetail(errorMessage(error));
      return;
    }

    const id = ++generation.current;
    const controller = new AbortController();
    requestController.current = controller;
    requestStartedAt.current = performance.now();
    setElapsedSeconds(0);
    setAssemblyProgress(null);
    setFormError('');
    setFormErrorDetail('');
    setResponseDecision(null);
    setFlow({ kind: 'requesting', message: `Sending this description to ${PROVIDER_LABELS[request.provider]} using ${request.model}.` });
    try {
      const response = await fetch('/api/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const decision = await readAssemblyResponse(response, progress => {
        if (id === generation.current) setAssemblyProgress(progress);
      });
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
        setQuestion('');
        setAnswer('');
        try {
          const scene = hasGroundPlane(decision.scene)
            ? decision.scene
            : validateScene({ ...decision.scene, ground: undefined });
          const document: SceneDocument = { prompt: request.description, decision, scene };
          void saveSceneDocument({ runtimeId: id, document, mode: 'prepare', urlMode: 'push' });
        } catch (error) {
          setFlow({ kind: 'error', message: 'The default ground could not be kept with this model.', detail: errorMessage(error) });
        }
      } else {
        throw new Error('The validated scene decision did not contain a scene.');
      }
    } catch (error) {
      if (id !== generation.current || isAbortError(error)) return;
      requestController.current = null;
      const failure = assemblyFailure(error);
      setFlow({ kind: 'error', message: failure.message, detail: failure.detail });
    } finally {
      if (id === generation.current && requestController.current === controller) requestController.current = null;
    }
  };

  const handleCanvasStatus = useCallback((id: number, message: string) => {
    if (id === generation.current) setFlow({ kind: 'preparing', message });
  }, []);

  const handleCanvasReady = (experiment: CanvasExperiment, nextSnapshot: InspectionSnapshot) => {
    if (experiment.id !== generation.current) return;
    const binding = pendingSceneBindingsRef.current.get(experiment.id);
    pendingSceneBindingsRef.current.delete(experiment.id);
    activeRef.current = experiment;
    candidateRef.current = null;
    setActiveExperiment(experiment);
    setPendingExperiment(current => current?.id === experiment.id ? null : current);
    setSnapshot(nextSnapshot);
    setResponseDecision(null);
    setBlockedRuntimeId(null);
    clearAfterPauseRef.current = false;
    failedRenewalRef.current = null;
    if (binding) {
      activeSavedRef.current = { runtimeId: experiment.id, saved: binding.saved };
      activeSceneUrlRef.current = binding.saved.id;
      activeSourcePromptRef.current = binding.saved.document.prompt;
      setSavedScene(binding.saved);
      setCurrentSceneId(binding.saved.id);
      setRecentScenes(rememberRecentScene(binding.saved.id, binding.saved.document.scene.title, binding.saved.expiresAt));
      setSceneError('');
      retryActionRef.current = null;
      if (binding.restorePrompt) {
        setDescription(binding.saved.document.prompt);
        setClarifications([]);
        setQuestion('');
        setAnswer('');
      }
      const path = `/scenes/${binding.saved.id}`;
      if (binding.urlMode === 'push' && window.location.pathname !== path) {
        window.history.pushState(null, '', path);
      } else if (binding.urlMode !== 'push' && window.location.pathname !== path) {
        window.history.replaceState(null, '', path);
      }
      finishSceneOperation(binding.operationToken);
    } else {
      activeSavedRef.current = null;
      activeSceneUrlRef.current = null;
      activeSourcePromptRef.current = '';
      setSavedScene(null);
      setCurrentSceneId(null);
      setSceneError('The preview is ready, but its saved scene record is unavailable. Save a new copy before running.');
      retryActionRef.current = null;
    }
    document.title = `${experiment.scene.title} | Physics Lab`;
    setFlow({ kind: 'ready', message: 'Physics preview ready. Use the controls below to run or pause the solver.' });
  };

  const handleCanvasSnapshot = useCallback((id: number, nextSnapshot: InspectionSnapshot) => {
    if (activeRef.current?.id === id) setSnapshot(nextSnapshot);
  }, []);

  const handleCanvasFailure = (id: number, message: string) => {
    if (id !== generation.current) return;
    const binding = pendingSceneBindingsRef.current.get(id);
    pendingSceneBindingsRef.current.delete(id);
    candidateRef.current = null;
    setPendingExperiment(current => current?.id === id ? null : current);
    finishSceneOperation(binding?.operationToken ?? -1);
    setFlow({ kind: 'error', message: 'The paused preview could not be prepared.', detail: message });
    if (!binding) {
      if (activeRef.current && !savedScene) {
        setSceneError('This setup has no active saved link. Save a new copy before running it.');
        retryActionRef.current = () => saveCurrentCopy();
      }
      return;
    }
    setSceneError(`The saved scene could not be prepared locally. ${message} Retry without another model request.`);
    const retryMode = binding.urlMode === 'initial' ? 'initial' : 'push';
    retryActionRef.current = () => { void loadSavedScene(binding.saved.id, retryMode); };
    const previousSceneUrlId = activeSavedRef.current?.saved.id ?? activeSceneUrlRef.current;
    if (binding.urlMode === 'pop' && previousSceneUrlId) {
      window.history.replaceState(null, '', `/scenes/${previousSceneUrlId}`);
    }
  };
  const cancelCurrentWork = (message: string) => {
    const candidate = candidateRef.current;
    const binding = candidate ? pendingSceneBindingsRef.current.get(candidate.id) : undefined;
    invalidateWork(message);
    if (!binding) {
      if (activeRef.current && !savedScene) {
        setSceneError('This setup has no active saved link. Save a new copy before running it.');
        retryActionRef.current = () => saveCurrentCopy();
      }
      return;
    }
    const previousSceneUrlId = activeSavedRef.current?.saved.id ?? activeSceneUrlRef.current;
    if (binding.urlMode === 'pop' && previousSceneUrlId) {
      window.history.replaceState(null, '', `/scenes/${previousSceneUrlId}`);
    }
    setSceneError('Scene preparation was canceled. Retry to open the saved record without another model request.');
    const retryMode = binding.urlMode === 'initial' ? 'initial' : 'push';
    retryActionRef.current = () => { void loadSavedScene(binding.saved.id, retryMode); };
  };

  const renewForRun = (runtimeId: number, showOperation = true): Promise<boolean> => {
    const inFlight = renewalFlightsRef.current.get(runtimeId);
    if (inFlight) return inFlight;
    const active = activeSavedRef.current;
    if (!active || active.runtimeId !== runtimeId) return Promise.resolve(false);
    const savedId = active.saved.id;
    const operationToken = showOperation ? beginSceneOperation('renewing') : null;
    const ownsFeedback = () => operationToken !== null && operationTokenRef.current === operationToken && !pendingSaveRef.current;
    if (activeRef.current?.id === runtimeId && ownsFeedback()) setSceneError('');
    let request: Promise<boolean>;
    request = (async () => {
      try {
        const metadata: SavedSceneMetadata = await renewSavedScene(savedId);
        if (metadata.id !== savedId) throw new Error('The local API returned retention metadata for a different scene.');
        const current = activeSavedRef.current;
        if (current?.runtimeId !== runtimeId || current.saved.id !== savedId) return false;
        const saved: SavedScene = { ...current.saved, ...metadata };
        activeSavedRef.current = { runtimeId, saved };
        setRecentScenes(rememberRecentScene(saved.id, saved.document.scene.title, saved.expiresAt));
        if (activeRef.current?.id === runtimeId) {
          setSavedScene(saved);
          setCurrentSceneId(saved.id);
          setBlockedRuntimeId(null);
          if (ownsFeedback()) {
            setSceneError('');
            retryActionRef.current = null;
          }
        }
        failedRenewalRef.current = null;
        return true;
      } catch (error) {
        const current = activeSavedRef.current;
        const isCurrent = current?.runtimeId === runtimeId && current.saved.id === savedId;
        const expired = error instanceof SavedSceneApiError && error.status === 404;
        if (expired) setRecentScenes(forgetRecentScene(savedId));
        if (isCurrent && activeRef.current?.id === runtimeId) {
          failedRenewalRef.current = runtimeId;
          setBlockedRuntimeId(runtimeId);
          if (expired) {
            activeSavedRef.current = null;
            setSavedScene(null);
            setCurrentSceneId(null);
            if (!pendingSaveRef.current) {
              setSceneError('This saved scene expired or is unavailable. Save a new copy of the current setup to create a fresh link.');
              retryActionRef.current = () => { void loadSavedScene(savedId, 'push'); };
            }
          } else if (ownsFeedback()) {
            setSceneError(`The scene could not be renewed before playback. ${errorMessage(error)} Retry the local API, then run again.`);
            retryActionRef.current = () => { void renewForRun(runtimeId); };
          }
        }
        return false;
      } finally {
        if (operationToken !== null) finishSceneOperation(operationToken);
        if (clearAfterPauseRef.current && activeRef.current?.id !== runtimeId && activeSavedRef.current?.runtimeId === runtimeId) {
          activeSavedRef.current = null;
          activeSourcePromptRef.current = '';
          clearAfterPauseRef.current = false;
        }
      }
    })().finally(() => {
      if (renewalFlightsRef.current.get(runtimeId) === request) renewalFlightsRef.current.delete(runtimeId);
    });
    renewalFlightsRef.current.set(runtimeId, request);
    return request;
  };

  const handleBeforeRun = (runtimeId: number): Promise<boolean> => {
    if (activeSavedRef.current?.runtimeId !== runtimeId) {
      if (activeRef.current?.id === runtimeId) {
        setBlockedRuntimeId(runtimeId);
        setSceneError('Save a new copy of this setup before running it.');
        retryActionRef.current = () => saveCurrentCopy();
      }
      return Promise.resolve(false);
    }
    return renewForRun(runtimeId);
  };

  const handlePlaybackChange = (runtimeId: number, playing: boolean) => {
    if (playing) {
      playbackRef.current = { id: runtimeId, playing: true };
      setPlayback({ id: runtimeId, playing: true });
      return;
    }
    if (playbackRef.current?.id === runtimeId) {
      playbackRef.current = null;
      setPlayback(null);
    }
    if (clearAfterPauseRef.current) {
      if (activeSavedRef.current?.runtimeId === runtimeId && failedRenewalRef.current !== runtimeId) {
        void renewForRun(runtimeId, false);
      } else {
        activeSavedRef.current = null;
        activeSourcePromptRef.current = '';
        clearAfterPauseRef.current = false;
      }
      return;
    }
    if (activeSavedRef.current?.runtimeId === runtimeId && failedRenewalRef.current !== runtimeId) {
      const showOperation = operationRef.current !== 'loading' && operationRef.current !== 'saving';
      void renewForRun(runtimeId, showOperation);
    }
  };

  useEffect(() => {
    if (!playback?.playing) return;
    const interval = window.setInterval(() => {
      if (playbackRef.current?.id === playback.id && playbackRef.current.playing) {
        const showOperation = operationRef.current !== 'loading' && operationRef.current !== 'saving';
        void renewForRun(playback.id, showOperation);
      }
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [playback?.id, playback?.playing]);

  const refreshActiveSavedScene = async (runtimeId: number, savedId: string) => {
    const requested = activeSavedRef.current;
    if (requested?.runtimeId !== runtimeId || requested.saved.id !== savedId) return;
    const operationToken = operationTokenRef.current;
    const beganIdle = operationRef.current === 'idle';
    const ownsFeedback = () => beganIdle && operationTokenRef.current === operationToken && !pendingSaveRef.current;
    try {
      const saved = await getSavedScene(savedId);
      if (saved.id !== savedId) throw new Error('The local API returned a different saved scene.');
      const current = activeSavedRef.current;
      if (current?.runtimeId !== runtimeId || current.saved.id !== savedId || activeRef.current?.id !== runtimeId) return;
      // A Run may have renewed the lease while this read was in flight.
      if (current.saved.expiresAt !== requested.saved.expiresAt || current.saved.lastRunAt !== requested.saved.lastRunAt) return;
      activeSavedRef.current = { runtimeId, saved };
      setSavedScene(saved);
      setCurrentSceneId(saved.id);
      setRecentScenes(rememberRecentScene(saved.id, saved.document.scene.title, saved.expiresAt));
      setBlockedRuntimeId(null);
      failedRenewalRef.current = null;
      if (ownsFeedback()) {
        setSceneError('');
        retryActionRef.current = null;
      }
    } catch (error) {
      const current = activeSavedRef.current;
      if (current?.runtimeId !== runtimeId || current.saved.id !== savedId || activeRef.current?.id !== runtimeId) return;
      if (current.saved.expiresAt !== requested.saved.expiresAt || current.saved.lastRunAt !== requested.saved.lastRunAt) return;
      if (error instanceof SavedSceneApiError && error.status === 404) {
        activeSavedRef.current = null;
        setSavedScene(null);
        setCurrentSceneId(null);
        setRecentScenes(forgetRecentScene(savedId));
        failedRenewalRef.current = runtimeId;
        setBlockedRuntimeId(runtimeId);
        if (!pendingSaveRef.current) {
          setSceneError('This saved scene expired or is unavailable. Save a new copy of the current setup to create a fresh link.');
          retryActionRef.current = () => { void loadSavedScene(savedId, 'push'); };
        }
      } else if (ownsFeedback()) {
        setSceneError(`The saved scene's current expiry could not be confirmed. ${errorMessage(error)} Retry the local API before running.`);
        retryActionRef.current = () => { void refreshActiveSavedScene(runtimeId, savedId); };
      }
    }
  };

  useEffect(() => {
    if (!savedScene) return;
    const savedId = savedScene.id;
    const runtimeId = activeSavedRef.current?.runtimeId;
    if (runtimeId === undefined) return;
    const expiryKey = `${savedId}:${savedScene.expiresAt}`;
    if (expiryCheckRef.current === expiryKey) return;
    const refresh = () => {
      expiryCheckRef.current = expiryKey;
      void refreshActiveSavedScene(runtimeId, savedId);
    };
    const delay = Date.parse(savedScene.expiresAt) - Date.now();
    if (delay <= 0) {
      refresh();
      return;
    }
    const timer = window.setTimeout(refresh, delay + 1);
    return () => window.clearTimeout(timer);
  }, [savedScene]);

  const retryPersistence = () => {
    if (retryActionRef.current) retryActionRef.current();
    else if (activeRef.current && !savedScene && !pendingSaveRef.current && !isBusy && sceneOperation === 'idle') saveCurrentCopy();
  };

  const clearToHome = () => {
    const wasPlaying = playbackRef.current?.playing === true;
    invalidateWork('The saved scene was closed.');
    sceneControllerRef.current?.abort();
    sceneControllerRef.current = null;
    operationTokenRef.current += 1;
    operationRef.current = 'idle';
    setSceneOperation('idle');
    retryActionRef.current = null;
    pendingSaveRef.current = null;
    setSceneError('');
    clearAfterPauseRef.current = wasPlaying;
    if (!wasPlaying) {
      activeSavedRef.current = null;
      activeSourcePromptRef.current = '';
      playbackRef.current = null;
      setPlayback(null);
    }
    activeRef.current = null;
    activeSceneUrlRef.current = null;
    candidateRef.current = null;
    pendingSceneBindingsRef.current.clear();
    setActiveExperiment(null);
    setPendingExperiment(null);
    setSavedScene(null);
    setCurrentSceneId(null);
    setSnapshot(null);
    setResponseDecision(null);
    setBlockedRuntimeId(null);
    setClearCanvasToken(current => current + 1);
    setFlow({ kind: 'idle', message: '' });
    document.title = 'Physics Lab';
  };

  useEffect(() => {
    const initialPath = window.location.pathname;
    const initialId = sceneIdFromPath(initialPath);
    if (initialId) {
      void loadSavedScene(initialId, 'initial');
    } else if (initialPath !== '/') {
      operationRef.current = 'idle';
      setSceneOperation('idle');
      setSceneError('This scene link is invalid or unavailable. Start a new experiment at /.');
    }
    const onPopState = () => {
      const path = window.location.pathname;
      const id = sceneIdFromPath(path);
      if (path === '/') {
        clearToHome();
      } else if (id) {
        void loadSavedScene(id, 'pop');
      } else {
        invalidateWork('The invalid scene navigation was canceled.');
        operationRef.current = 'idle';
        setSceneOperation('idle');
        setSceneError('This scene link is invalid or unavailable. Start a new experiment at /.');
        retryActionRef.current = null;
        const previousSceneUrlId = activeSavedRef.current?.saved.id ?? activeSceneUrlRef.current;
        if (previousSceneUrlId) window.history.replaceState(null, '', `/scenes/${previousSceneUrlId}`);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const interpretation = activeExperiment?.decision ?? null;
  const noProvidersAvailable = config !== null && availableProviders.length === 0;
  const sceneTransitionBusy = sceneOperation === 'loading' || sceneOperation === 'saving';
  const canSubmit = !isBusy && !sceneTransitionBusy && !pendingSaveRef.current && !configError && provider !== '' && selectedModel.length > 0 && description.trim().length >= 3;
  const settingsSummary = provider
    ? `${selectedProviderLabel} / ${selectedModel || 'model not selected'}`
    : 'Choose provider and model';


  return (
    <div className="lab-shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="Physics Lab home">
          <Atom className="brand__icon" size={22} aria-hidden="true" />
          <span className="brand__name">Physics Lab</span>
          <span className="brand__scope">Mechanics</span>
        </a>
        <div className="service-state" aria-live="polite">
          <span className={`service-state__signal ${config && !configError ? 'is-live' : ''}`} aria-hidden="true" />
          {configError ? 'API unavailable' : config ? 'Local API connected' : 'Connecting to local API'}
        </div>
      </header>

      <main id="main" className="mission-board">
        <section className="setup-panel" aria-labelledby="setup-title">
          <h1 id="setup-title">New experiment</h1>

          <form className="assembly-form" onSubmit={handleSubmit}>
            <label className="field description-field">
              <span className="field-label">Describe the setup</span>
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
              <span className="field-hint" id="description-hint">Missing details are asked about, or filled with stated defaults.</span>
            </label>

            <div className="prompt-starters" role="group" aria-label="Fill the editable prompt with a starter">
              <span className="field-label">Examples</span>
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
            <label className="field category-field">
              <span className="field-label">Physics category</span>
              <select defaultValue="mechanics">
                <option value="mechanics">Mechanics</option>
              </select>
            </label>

            <details className="settings-details">
              <summary className="settings-summary">
                <span className="settings-summary__title">Model</span>
                <span className="settings-summary__selection">{selectedModel || 'Not selected'}</span>
              </summary>
              <div className="settings-content">
                <p className="settings-intro">Changes apply on the next assembly. API keys stay on the local server.</p>
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
                          {item.label}{item.available ? '' : ' (not configured)'}
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
                          onChange={event => {
                            if (sceneOperation === 'loading') return;
                            invalidateWork();
                            setFreeModel(event.target.value);
                            setModelInput('');
                            setFormError('');
                            setFormErrorDetail('');
                          }}
                          disabled={isBusy}
                        >
                          <option value="" disabled>Choose a free route or enter a model ID</option>
                          {[OPENROUTER_FREE_ROUTE, ...models.filter(item => item.free && item.id !== OPENROUTER_FREE_ROUTE.id)].map(item => (
                            <option value={item.id} key={item.id}>{`${item.name} (${item.id}, free)`}</option>
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
                    onChange={event => handleAnswerChange(event.target.value)}
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
                <p><strong>Provider settings could not be loaded.</strong> Retry without losing your draft. If the local service is offline, start it with <code>npm run api</code>.</p>
                <button className="secondary-button" type="button" onClick={() => setConfigAttempt(current => current + 1)}>Retry connection</button>
                <details className="diagnostic-details"><summary>Technical details</summary><p>{configError}</p></details>
              </div>
            ) : null}
            {noProvidersAvailable ? (
              <div className="notice notice--warning" role="status">
                <p><strong>No provider key is configured.</strong> Add <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, or <code>OPENROUTER_API_KEY</code> to a private server-side environment file, restart the local API, then check again. Never expose a key in browser code.</p>
                <button className="secondary-button" type="button" onClick={() => setConfigAttempt(current => current + 1)}>Check provider availability</button>
              </div>
            ) : null}
            {formError ? (
              <div className="notice notice--error" role="alert">
                <p>{formError}</p>
                {formErrorDetail ? <details className="diagnostic-details"><summary>Technical details</summary><p>{formErrorDetail}</p></details> : null}
              </div>
            ) : null}

            <div className="submit-row">
              <p className="privacy-note">Your description is sent to the selected model. One automatic retry may add a provider charge. No paid fallback is used.</p>
              <div className="submit-actions">
                <button className="primary-button" type="submit" disabled={!canSubmit || (question !== '' && answer.trim().length === 0)}>
                  <span>{flow.kind === 'requesting' ? 'Waiting for model' : flow.kind === 'preparing' ? 'Building preview' : flow.kind === 'error' ? 'Retry request' : question ? 'Answer and continue' : 'Assemble scene'}</span>
                  {isBusy ? null : <ArrowRight size={16} weight="bold" aria-hidden="true" />}
                </button>
              </div>
            </div>
          </form>

          {flow.message && !isBusy && flow.kind !== 'unsupported' && flow.kind !== 'clarification' && flow.kind !== 'ready' ? (
            <div ref={flow.kind === 'error' ? flowMessageRef : undefined} tabIndex={flow.kind === 'error' ? -1 : undefined} className={`flow-message flow-message--${flow.kind}`} role={flow.kind === 'error' ? 'alert' : 'status'} aria-live={flow.kind === 'error' ? 'assertive' : 'polite'}>
              <span className="flow-message__line" aria-hidden="true" />
              <div className="flow-message__content">
                <p>{flow.message}</p>
                {flow.kind === 'error' ? <p className="flow-message__next">Your prompt and current preview are unchanged. Retry this request as written, edit the experiment, or review provider settings.</p> : null}
                {flow.kind === 'error' && flow.detail ? <details className="diagnostic-details"><summary>Technical details</summary><p>{flow.detail}</p></details> : null}
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


          {recentScenes.length > 0 ? (
            <section className="recent-section" aria-labelledby="recent-title">
              <h2 id="recent-title">Recent scenes</h2>
              <ul className="recent-list">
                {recentScenes.map(item => (
                  <li key={item.id}>
                    <button
                      className="recent-item"
                      type="button"
                      onClick={() => loadRecentScene(item)}
                      aria-current={currentSceneId === item.id ? 'true' : undefined}
                      title="Load the saved scene without a model request"
                    >
                      <ClockCounterClockwise size={16} aria-hidden="true" />
                      <strong>{item.title}</strong>
                      {currentSceneId === item.id ? <small>Open</small> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <details className="capabilities-details">
            <summary>What this lab can model</summary>
            <div className="capabilities-copy">
              <p>Classical mechanics with rigid bodies and point particles, gravity and applied loads, collisions and contacts, joints, and cable or spring connections.</p>
              <p>Contacts include elastic, partially elastic and inelastic restitution targets, static and kinetic sliding friction, and torsional/rolling resistance. Pair restitution uses the lower coefficient; pair friction uses the higher. Ground is a real physical surface by default.</p>
              <p><strong>Model boundaries:</strong> rigid bodies and compliant numerical contacts, not deformation or fluid fields. Material coefficients are numerical targets with finite-step error; inspect the declared assumptions and actual results.</p>
              <p><strong>Display:</strong> the grid and 1 m axes are visual aids, not a floor. Infinite planes render as finite patches, and point markers are not physical radii.</p>
            </div>
          </details>
        </section>

        <section className="simulation-section" aria-labelledby="simulation-title">
          <h2 id="simulation-title" className="visually-hidden">Simulation</h2>
          {interpretation?.approximation ? (
            <div className="approximation-notice" role="note">
              <strong>Approximate model. Review before running.</strong>
              <p>{interpretation.approximation}</p>
            </div>
          ) : null}
          <SceneLinkBar
            saved={savedScene}
            operation={sceneOperation}
            error={sceneError}
            onRetry={retryPersistence}
            onSaveCopy={activeExperiment && !savedScene && !pendingSaveRef.current && sceneOperation === 'idle' && !isBusy ? saveCurrentCopy : undefined}
          />
          <div className="stage">
            {isBusy ? (
              <div className="assembly-progress" data-stage={flow.kind} role="status" aria-live="polite" ref={progressRef} tabIndex={-1}>
                <div className="assembly-progress__heading">
                  <strong>{flow.kind === 'preparing' ? 'Building the preview' : assemblyProgress?.stage === 'retrying' ? 'Reconnecting to the model' : assemblyProgress?.stage === 'repairing' ? 'Correcting the model' : assemblyProgress?.stage === 'reviewing' ? 'Looking for a buildable model' : assemblyProgress?.stage === 'validating' ? 'Checking the physics' : 'Designing your experiment'}</strong>
                  <output aria-label="Elapsed assembly time" aria-live="off">{Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}</output>
                </div>
                <div className="assembly-progress__track" aria-hidden="true"><span /></div>
                <ol className="assembly-progress__steps" aria-label="Assembly stages">
                  <li data-state={flow.kind === 'preparing' || (assemblyProgress && assemblyProgress.stage !== 'generating' && assemblyProgress.stage !== 'retrying') ? 'done' : 'active'}>Design</li>
                  <li data-state={flow.kind === 'preparing' ? 'done' : assemblyProgress && assemblyProgress.stage !== 'generating' && assemblyProgress.stage !== 'retrying' ? 'active' : 'pending'}>{assemblyProgress?.stage === 'repairing' ? 'Correct' : assemblyProgress?.stage === 'reviewing' ? 'Review' : 'Validate'}</li>
                  <li data-state={flow.kind === 'preparing' ? 'active' : 'pending'}>Build</li>
                </ol>
                <p>{flow.kind === 'requesting'
                  ? assemblyProgress?.message ?? `Connecting to ${selectedProviderLabel}.`
                  : flow.message}</p>
                {flow.kind === 'requesting' && elapsedSeconds >= 15 ? <p className="assembly-progress__slow">Free models can take up to two minutes per attempt. Your draft and current preview are safe.</p> : null}
                <details className="assembly-progress__request">
                  <summary>Request details</summary>
                  <div>
                    <span className="assembly-progress__route">{selectedModel}</span>
                    <p>{description}</p>
                    {clarifications.map((item, index) => (
                      <p key={`${index}-${item.question}`}><strong>Clarification {index + 1}:</strong> {item.question}<br /><strong>Answer:</strong> {item.answer}</p>
                    ))}
                    {question ? <p><strong>Clarification:</strong> {question}<br /><strong>Answer:</strong> {answer.trim() || 'Not answered yet.'}</p> : null}
                  </div>
                </details>
                <button className="secondary-button" type="button" onClick={() => {
                  cancelCurrentWork(flow.kind === 'requesting'
                    ? 'Stopped waiting. Your prompt and current preview are unchanged. The provider may continue processing; charges may still apply.'
                    : 'Preview preparation canceled. Your prompt and current preview are unchanged.');
                  descriptionRef.current?.focus();
                }}>{flow.kind === 'requesting' ? 'Stop waiting' : 'Cancel'}</button>
              </div>
            ) : null}
            <SimulationCanvas
              experiment={pendingExperiment}
              replacementPending={isBusy || sceneTransitionBusy}
              onStatus={handleCanvasStatus}
              onReady={handleCanvasReady}
              onSnapshot={handleCanvasSnapshot}
              onFailure={handleCanvasFailure}
              onBeforeRun={handleBeforeRun}
              onPlaybackChange={handlePlaybackChange}
              playbackBlocked={blockedRuntimeId === activeExperiment?.id}
              runToken={generation.current}
              clearToken={clearCanvasToken}
              physicalGround={Boolean(activeExperiment?.scene.ground)}
              groundDisabled={!activeExperiment || isBusy || sceneTransitionBusy}
              onPhysicalGroundChange={togglePhysicalGround}
            />
          </div>
          {interpretation ? (
            <section className={`interpretation-panel${responseDecision ? ' interpretation-panel--preserved' : ''}`} aria-labelledby="interpretation-title">
              <div className="interpretation-heading">
                <h2 id="interpretation-title">{interpretation.scene?.title ?? 'This scene'}</h2>
                {responseDecision ? <span className="interpretation-tag">Unchanged preview</span> : null}
              </div>
              <p className="interpretation-summary">{interpretation.summary}</p>
              <div className="interpretation-body">
                {interpretation.assumptions.length > 0 ? (
                  <details className="assumption-list" open>
                    <summary>Assumptions ({interpretation.assumptions.length})</summary>
                    <ul>{interpretation.assumptions.map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}</ul>
                  </details>
                ) : <p className="assumption-empty">No additional assumptions reported.</p>}
                <div className="ground-facts">
                  {activeExperiment && activeExperiment.scene.ground ? (
                    <p className="ground-line">
                      <strong>Ground</strong> at z = {activeExperiment.scene.ground.height} m, restitution {activeExperiment.scene.ground.restitution}, sliding friction {activeExperiment.scene.ground.friction.sliding}.
                    </p>
                  ) : <p className="ground-line"><strong>Ground</strong> off. Modeled supports are listed under Objects.</p>}
                  {activeExperiment
                    && activeExperiment.decision.kind === 'scene'
                    && activeExperiment.decision.scene.ground === null
                    && !hasGroundPlane(activeExperiment.decision.scene)
                    && activeExperiment.scene.ground
                    ? <p className="ground-note" role="note">The model proposed no ground, so the default was kept. Switch it off on the canvas if you want free flight.</p>
                    : null}
                </div>
              </div>
            </section>
          ) : null}
          <TelemetryPanel experimentId={activeExperiment?.id ?? null} snapshot={snapshot} />
          <ObjectCards snapshot={snapshot} hasExperiment={activeExperiment !== null || pendingExperiment !== null} />
        </section>

      </main>
      <footer className="page-footer">
        <span>Mechanics only. SI units, Z up. Results are numerical approximations; inspection is read-only.</span>
      </footer>
    </div>
  );
}

