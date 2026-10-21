import { ArrowDown, ArrowRight, Atom, BookOpen, CaretDown, ChatCircleDots, ClockCounterClockwise, Cube, SlidersHorizontal } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ZodError } from 'zod';
import { CONNECTED_GPT_MODEL, PROVIDER_LABELS, type ModelOption, type ProviderConfig } from '../shared/catalog.ts';
import { HARNESS_MAX_TURNS, HARNESS_TIMEOUT_MS, HarnessRequestSchema, type HarnessBudget, type HarnessRequest } from '../shared/harness.ts';
import { validateScene, type Decision, type Provider } from '../shared/scene.ts';
import { SavedSceneIdSchema, type SavedScene, type SavedSceneMetadata, type SceneDocument } from '../shared/saved-scene.ts';
import { readAssemblyResponse, type AssemblyProgress } from '../shared/assembly-stream.ts';
import type { VerificationReceipt } from '../shared/verification.ts';
import type { LabOutcome, ReviewProposal } from '../shared/review-proposal.ts';
import { AppearanceSchema, type Appearance } from '../shared/appearance.ts';
import { EXPERIMENT_EXAMPLES, type ExampleSetup } from '../shared/examples.ts';
import ExampleLibrary from './ExampleLibrary.tsx';
import AssemblyWork, { type AssemblyActivity } from './AssemblyWork.tsx';
import ObjectCards from './ObjectCards.tsx';
import SimulationCanvas, { type CanvasExperiment } from './SimulationCanvas.tsx';
import SceneLinkBar from './SceneLinkBar.tsx';
import { createSavedScene, forgetRecentScene, getSavedScene, readRecentScenes, rememberRecentScene, renewSavedScene, SavedSceneApiError, type RecentScene } from './saved-scenes.ts';
import TelemetryPanel from './TelemetryPanel.tsx';
import SceneTimeline from './SceneTimeline.tsx';
import type { InspectionSnapshot } from './physics/types.ts';
type SceneDecision = Extract<Decision, { kind: 'scene' }>;
type ConversationMessage = { role: 'user' | 'assistant'; content: string };
type PendingConversation = { runtimeId: number; user: string; summary: string };
const MAX_SAVED_PROMPT_LENGTH = 16000;
type SceneUrlMode = 'push' | 'pop' | 'initial';
type SceneOperation = 'idle' | 'saving' | 'loading' | 'renewing';
type PendingSceneSave = { runtimeId: number; document: SceneDocument; mode: 'prepare' | 'copy' | 'appearance'; urlMode: SceneUrlMode; proposalReplacement?: boolean; restorePrompt?: boolean };
type ActiveSceneBinding = { runtimeId: number; saved: SavedScene };
type SceneBinding = { saved: SavedScene; urlMode: SceneUrlMode; operationToken: number; restorePrompt: boolean };
type PreviousPreview = {
  experiment: CanvasExperiment | null;
  savedScene: SavedScene | null;
  activeSaved: ActiveSceneBinding | null;
  sourcePrompt: string;
  sceneError: string;
  sceneUrl: string | null;
  currentSceneId: string | null;
  retryAction: (() => void) | null;
};
type ReviewProposalContext = {
  runtimeId: number;
  proposal: ReviewProposal;
  sourcePrompt: string;
  userTurn: string;
  previous: PreviousPreview;
  accepted?: SavedScene;
  keeping?: boolean;
  priorProposal?: ReviewProposalContext;
};
type PendingPreviewRestore = { runtimeId: number; previous: PreviousPreview };

type Flow = {
  kind: 'idle' | 'requesting' | 'clarification' | 'preparing' | 'ready' | 'proposal' | 'unsupported' | 'error';
  message: string;
  detail?: string;
};

const OPENROUTER_FREE_ROUTE: ModelOption = {
  id: 'openrouter/free',
  name: 'Random free router',
  free: true,
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
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof TypeError ? 'assembly_connection_lost' : '';
  const messages: Record<string, string> = {
    missing_credentials: 'Connect an AI service to build experiments.',
    connection_not_enabled: 'The person running this lab has not enabled Connected GPT.',
    unsupported_model: 'This AI model is not available for this lab.',
    provider_timeout: 'The AI service took too long. Please try again.',
    provider_rate_limited: 'The AI service has reached a usage limit. Try later or choose another connection.',
    provider_busy: 'Your AI service is overloaded. Your request is kept; try again later.',
    provider_authentication_failed: 'The AI service rejected its connection. Check that its credentials are current.',
    provider_response_too_large: 'The AI service sent more data than the lab can safely process.',
    invalid_provider_response: 'The AI service returned a response the lab could not use. Try another model.',
    provider_unavailable: 'The AI service could not finish this request.',
    docker_unavailable: 'The lab’s isolated workspace is unavailable.',
    sandbox_image_missing: 'The lab needs to finish its server setup.',
    sandbox_start_failed: 'The lab could not open an isolated workspace.',
    sandbox_resource_limit: 'The assistant stopped after possibly reaching a safe resource limit.',
    sandbox_worker_failed: 'The lab assistant stopped unexpectedly.',
    sandbox_protocol_failed: 'The lab assistant sent an unreadable response.',
    sandbox_input_limit: 'This experiment exceeded a safe data limit while reaching the assistant.',
    sandbox_output_limit: 'The assistant returned more data than the lab can safely process.',
    sandbox_io_failed: 'The connection to the isolated assistant was interrupted.',
    lab_busy: 'The assistant is helping with other experiments. Try again shortly.',
    lab_timeout: 'This update took too long. Please try again.',
    lab_limit: 'The assistant used its available attempts before finishing.',
    lab_incomplete: 'The assistant could not finish a checked experiment.',
    lab_protocol_error: 'The isolated assistant returned an invalid response.',
    lab_tool_scope: 'The assistant’s tool permissions did not match its current task.',
    required_tool_unavailable: 'The assistant’s required lab tool was unavailable.',
    provider_tool_choice_rejected: 'Your AI service rejected the required lab-tool request.',
    visual_check_failed: 'The scene preview could not be visually inspected.',
    lab_canceled: 'The lab assistant was stopped.',
    model_budget: 'The assistant could not finish within this update’s request allowance.',
    tool_budget: 'The assistant reached this update’s lab-action limit.',
    malformed_json: 'The assistant could not prepare usable experiment data.',
    invalid_schema: 'The assistant could not prepare an experiment in the supported format.',
    physics_check_failed: 'The physics check could not complete.',
    review_failed: 'The checked experiment could not pass its final review.',
    review_unstarted: 'The assistant could not begin its final review.',
    review_unusable: 'The AI reviewer did not return a usable verdict.',
    review_rejected: 'The final check still found a mismatch.',
    internal: 'The lab assistant encountered an internal problem.',
    internal_error: 'The lab encountered an internal problem—not a problem with your physics request.',
    assembly_connection_lost: 'The connection to the lab was interrupted. Your request is kept.',
    assembly_invalid_response: 'The lab sent an unreadable response. Your request is kept.',
    assembly_response_too_large: 'The lab response exceeded its size limit.',
    assembly_service_error: 'The lab service could not complete this request.',
    protocol: 'The isolated assistant returned an invalid response.',
  };
  const message = Object.hasOwn(messages, code) ? messages[code] : 'The lab could not finish this experiment.';
  return { message, detail: Object.hasOwn(messages, code) ? errorMessage(error) : /^[a-z][a-z0-9_]{0,79}$/.test(code) ? `Failure code: ${code}. Your message and previous experiment are preserved.` : 'No experiment was replaced. Your message is kept so you can try again.' };
}
function sceneIdFromPath(pathname: string): string | null {
  const match = /^\/scenes\/([^/]+)\/?$/.exec(pathname);
  if (!match || !SavedSceneIdSchema.safeParse(match[1]).success) return null;
  return match[1];
}

const REVIEW_CONCERN_CATEGORIES: Record<string, string> = {
  relationship: 'Connections',
  parameter: 'Settings',
  initial_contact: 'Contact',
  initial_motion: 'Motion',
  missing_action: 'Actions',
  unsupported_claim: 'Request',
  check_coverage: 'Checks',
  visual_quality: 'Appearance',
};




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
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [clarifications, setClarifications] = useState<{ question: string; answer: string }[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [responseDecision, setResponseDecision] = useState<Decision | null>(null);
  const [flow, setFlow] = useState<Flow>({ kind: 'idle', message: '' });
  const [activeExperiment, setActiveExperiment] = useState<CanvasExperiment | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [pendingExperiment, setPendingExperiment] = useState<CanvasExperiment | null>(null);
  const [savedScene, setSavedScene] = useState<SavedScene | null>(null);
  const [sceneOperation, setSceneOperation] = useState<SceneOperation>(() => window.location.pathname.startsWith('/scenes/') ? 'loading' : 'idle');
  const [sceneError, setSceneError] = useState('');
  const [recentScenes, setRecentScenes] = useState<RecentScene[]>(() => readRecentScenes());
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null);
  const [clearCanvasToken, setClearCanvasToken] = useState(0);
  const [playback, setPlayback] = useState<{ id: number; playing: boolean } | null>(null);
  const [blockedRuntimeId, setBlockedRuntimeId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<InspectionSnapshot | null>(null);
  const [formError, setFormError] = useState('');
  const [formErrorDetail, setFormErrorDetail] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [assemblyProgress, setAssemblyProgress] = useState<AssemblyProgress | null>(null);
  const [verificationReceipt, setVerificationReceipt] = useState<VerificationReceipt | null>(null);
  const [reviewProposal, setReviewProposal] = useState<ReviewProposalContext | null>(null);
  const [assemblyBudget, setAssemblyBudget] = useState<HarnessBudget | null>(null);
  const [assemblyActivity, setAssemblyActivity] = useState<AssemblyActivity[]>([]);
  const requestStartedAt = useRef(0);
  const progressRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLOListElement>(null);
  const responseRef = useRef<HTMLElement>(null);
  const flowMessageRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const candidateRef = useRef<CanvasExperiment | null>(null);
  const activeRef = useRef<CanvasExperiment | null>(null);
  const activeSavedRef = useRef<ActiveSceneBinding | null>(null);
  const activeSceneUrlRef = useRef<string | null>(null);
  const activeSourcePromptRef = useRef('');
  const pendingConversationRef = useRef<PendingConversation | null>(null);
  const pendingSceneBindingsRef = useRef(new Map<number, SceneBinding>());
  const reviewProposalRef = useRef<ReviewProposalContext | null>(null);
  const pendingPreviewRestoreRef = useRef<PendingPreviewRestore | null>(null);
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
  const setReviewProposalContext = (next: ReviewProposalContext | null) => {
    reviewProposalRef.current = next;
    setReviewProposal(next);
  };

  useEffect(() => {
    if (question && flow.kind === 'clarification') answerRef.current?.focus();
  }, [flow.kind, question]);

  useEffect(() => {
    const list = conversationRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [conversation]);


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
        if (initialProvider === 'openai-codex') setModelInput(CONNECTED_GPT_MODEL);
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
    const proposal = reviewProposalRef.current;
    if (proposal && candidateRef.current?.id === proposal.runtimeId && activeRef.current?.id !== proposal.runtimeId) {
      setReviewProposalContext(proposal.priorProposal ?? null);
    }
    setVerificationReceipt(null);
    const wasWorking = requestController.current !== null || candidateRef.current !== null
      || pendingSaveRef.current?.mode === 'prepare' || (sceneControllerRef.current !== null && operationRef.current === 'loading');
    if (wasWorking) setElapsedSeconds(Math.floor((performance.now() - requestStartedAt.current) / 1000));
    else if (!reviewProposalRef.current) {
      setAssemblyBudget(null);
      setAssemblyActivity([]);
      setAssemblyProgress(null);
    }
    generation.current += 1;
    pendingConversationRef.current = null;
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
    setModelInput(value === 'openai-codex' ? CONNECTED_GPT_MODEL : '');
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
    ?? (provider ? PROVIDER_LABELS[provider] : 'Not connected');
  const availableProviders = config?.providers.filter(item => item.available) ?? [];
  const isBusy = flow.kind === 'requesting' || flow.kind === 'preparing';

  useEffect(() => {
    if (!isBusy) return;
    progressRef.current?.scrollIntoView({ block: 'nearest' });
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
    setFlow({ kind: 'preparing', message: 'Building your paused physics preview.' });
  };

  const saveSceneDocument = async (pending: PendingSceneSave) => {
    if (pending.mode === 'prepare' && pending.runtimeId !== generation.current) return;
    if (pending.mode !== 'prepare' && activeRef.current?.id !== pending.runtimeId) return;
    sceneControllerRef.current?.abort();
    const controller = new AbortController();
    sceneControllerRef.current = controller;
    pendingSaveRef.current = pending;
    const operationToken = beginSceneOperation('saving');
    setSceneError('');
    if (pending.mode === 'prepare') {
      setAssemblyProgress(null);
      setFlow({ kind: 'preparing', message: 'Saving this scene before building its paused preview.' });
    }
    try {
      const saved = await createSavedScene(pending.document, controller.signal);
      const stillCurrent = pending.mode === 'prepare'
        ? pending.runtimeId === generation.current
        : activeRef.current?.id === pending.runtimeId;
      if (controller.signal.aborted || !stillCurrent) return;
      if (pending.proposalReplacement && reviewProposalRef.current) {
        setReviewProposalContext({ ...reviewProposalRef.current, accepted: saved });
      }
      sceneControllerRef.current = null;
      pendingSaveRef.current = null;
      setRecentScenes(rememberRecentScene(saved.id, saved.document.scene.title, saved.expiresAt));
      if (pending.mode !== 'prepare') {
        if (pending.mode === 'appearance') {
          const current = activeRef.current;
          if (!current || current.id !== pending.runtimeId) return;
          const updated = { ...current, scene: saved.document.scene, decision: saved.document.decision };
          activeRef.current = updated;
          setActiveExperiment(updated);
        }
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
        if (pending.mode === 'appearance' && playbackRef.current?.playing) void renewForRun(pending.runtimeId, false);
        return;
      }
      pendingSceneBindingsRef.current.set(pending.runtimeId, {
        saved,
        urlMode: pending.urlMode,
        operationToken,
        restorePrompt: pending.restorePrompt ?? false,
      });
      preparePreview(saved.document.decision, pending.runtimeId, saved.document.userGroundChoice, saved.document.scene);
    } catch (error) {
      if (controller.signal.aborted || pending.runtimeId !== (pending.mode === 'prepare' ? generation.current : activeRef.current?.id)) return;
      sceneControllerRef.current = null;
      finishSceneOperation(operationToken);
      pendingSaveRef.current = pending;
      setSceneError(pending.mode === 'appearance'
        ? `This look has not been saved. Your previous link is unchanged. ${errorMessage(error)}`
        : `This scene could not be saved. ${errorMessage(error)} Retry the local API without generating the scene again.`);
      retryActionRef.current = () => { void saveSceneDocument(pending); };
      if (pending.mode === 'prepare') {
        setVerificationReceipt(null);
        setFlow(activeRef.current ? { kind: 'ready', message: 'The existing physics preview is unchanged.' } : { kind: 'idle', message: '' });
      }
    }
  };

  const examplesUnavailable = () => isBusy || requestController.current !== null || candidateRef.current !== null
    || operationRef.current === 'loading' || operationRef.current === 'saving'
    || pendingSaveRef.current !== null || reviewProposalRef.current !== null;

  const openExample = (setup: ExampleSetup) => {
    if (examplesUnavailable()) return;
    setExamplesOpen(false);
    pendingPreviewRestoreRef.current = null;
    invalidateWork('Opening an example. The current preview stays available until it is ready.');
    setAssemblyBudget(null);
    setVerificationReceipt(null);
    setAssemblyProgress(null);
    setAssemblyActivity([]);
    requestStartedAt.current = performance.now();
    setElapsedSeconds(0);
    void saveSceneDocument({
      runtimeId: generation.current,
      document: setup.document,
      mode: 'prepare',
      urlMode: 'push',
      restorePrompt: true,
    });
    requestAnimationFrame(() => document.querySelector('.simulation-section')?.scrollIntoView({ block: 'start' }));
  };

  const loadSavedScene = async (id: string, urlMode: SceneUrlMode, preserveProposal = false) => {
    if (!preserveProposal) pendingPreviewRestoreRef.current = null;
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
    setAssemblyBudget(null);
    setVerificationReceipt(null);
    setAssemblyProgress(null);
    setAssemblyActivity([]);
    requestStartedAt.current = performance.now();
    setElapsedSeconds(0);
    const runtimeId = generation.current;
    const controller = new AbortController();
    sceneControllerRef.current = controller;
    const operationToken = beginSceneOperation('loading');
    setSceneError('');
    retryActionRef.current = () => { void loadSavedScene(id, urlMode === 'initial' ? 'initial' : 'push', preserveProposal); };
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
        retryActionRef.current = () => { void loadSavedScene(id, 'push', preserveProposal); };
      } else {
        setSceneError(unavailable ? 'This scene link is unavailable or has expired.' : `This saved scene could not be opened. ${errorMessage(error)} Retry the local request.`);
        retryActionRef.current = () => { void loadSavedScene(id, urlMode === 'initial' ? 'initial' : 'push', preserveProposal); };
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

  const changeAppearance = (input: Appearance) => {
    const current = activeRef.current;
    if (!current || current.decision.kind !== 'scene' || reviewProposalRef.current || isBusy || sceneOperation !== 'idle' || pendingSaveRef.current) return;
    const appearance = AppearanceSchema.parse(input);
    if (JSON.stringify(appearance) === JSON.stringify(current.scene.appearance)) return;
    const scene = validateScene({ ...current.scene, appearance });
    const decision: SceneDecision = { ...current.decision, scene: { ...current.decision.scene, appearance } };
    const document: SceneDocument = {
      prompt: activeSourcePromptRef.current, decision, scene,
      ...(current.userGroundChoice ? { userGroundChoice: current.userGroundChoice } : {}),
    };
    void saveSceneDocument({ runtimeId: current.id, document, mode: 'appearance', urlMode: 'push' });
  };

  const togglePhysicalGround = (include: boolean) => {
    const current = activeRef.current;
    if (!current || current.decision.kind !== 'scene' || reviewProposalRef.current || isBusy || sceneOperation === 'loading' || sceneOperation === 'saving') return;
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
    if (isBusy || sceneOperation === 'loading' || sceneOperation === 'saving' || pendingSaveRef.current || reviewProposalRef.current?.accepted || reviewProposalRef.current?.keeping) return;
    const proposalForRequest = reviewProposalRef.current?.runtimeId === activeExperiment?.id ? reviewProposalRef.current : null;
    const sourcePromptBase = proposalForRequest?.sourcePrompt ?? activeSourcePromptRef.current;
    const clarification = question
      ? [...clarifications, { question, answer: answer.trim() }]
      : clarifications;
    const history = conversation
      .slice(-24)
      .map(({ role, content }) => ({ role, content }));
    let request: HarnessRequest;
    let sourcePrompt: string;
    try {
      request = HarnessRequestSchema.parse({
        provider,
        model: selectedModel,
        description,
        clarification,
        history,
        currentScene: activeExperiment?.scene ?? null,
        sourcePrompt: activeExperiment ? sourcePromptBase : null,
        sourceAssumptions: activeExperiment?.decision.assumptions ?? [],
      });
      const sourcePromptParts = sourcePromptBase
        ? [
          sourcePromptBase,
          ...(request.description === sourcePromptBase ? [] : [`Follow-up: ${request.description}`]),
        ]
        : [request.description];
      sourcePrompt = [
        ...sourcePromptParts,
        ...request.clarification.map(item => `Clarification: ${item.question}\nAnswer: ${item.answer}`),
      ].join('\n\n');
    } catch (error) {
      setFormError('Review the experiment description and model settings.');
      setFormErrorDetail(errorMessage(error));
      return;
    }
    if (sourcePrompt.length > MAX_SAVED_PROMPT_LENGTH) {
      setFormError('This follow-up would exceed the saved-scene prompt limit of 16,000 characters. Keep it shorter or start a new experiment; the current scene is unchanged.');
      setFormErrorDetail('');
      return;
    }

    const userTurn = question ? answer.trim() : request.description;
    const id = ++generation.current;
    const controller = new AbortController();
    requestController.current = controller;
    requestStartedAt.current = performance.now();
    setElapsedSeconds(0);
    setAssemblyProgress(null);
    setVerificationReceipt(null);
    setAssemblyBudget(null);
    setAssemblyActivity([]);
    setFormError('');
    setFormErrorDetail('');
    setResponseDecision(null);
    setFlow({ kind: 'requesting', message: `Sending this request to ${PROVIDER_LABELS[request.provider]} using ${request.model}.` });
    try {
      const response = await fetch('/api/lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const outcome: LabOutcome = await readAssemblyResponse(response, progress => {
        if (id !== generation.current) return;
        setAssemblyProgress(progress);
        if (progress.verification) setVerificationReceipt(progress.verification);
        if (progress.budget) setAssemblyBudget(progress.budget);
        setAssemblyActivity(current => {
          const previous = current.at(-1);
          const entry: AssemblyActivity = { type: 'progress', ...progress };
          if (previous?.type === 'progress' && previous.stage === progress.stage && previous.message === progress.message
            && previous.budget?.modelRequests === progress.budget?.modelRequests) return [...current.slice(0, -1), entry];
          return [...current, entry].slice(-24);
        });
      }, text => {
        if (id !== generation.current) return;
        setAssemblyActivity(current => {
          const previous = current.at(-1);
          if (previous?.type === 'assistant') return [...current.slice(0, -1), { type: 'assistant' as const, text: previous.text + text }];
          return [...current, { type: 'assistant' as const, text }].slice(-24);
        });
      });
      if (id !== generation.current) return;
      requestController.current = null;
      setElapsedSeconds(Math.floor((performance.now() - requestStartedAt.current) / 1000));
      if (question) setClarifications(clarification);

      if (outcome.kind === 'proposal') {
        const previous = proposalForRequest?.previous ?? {
          experiment: activeExperiment,
          savedScene,
          activeSaved: activeSavedRef.current,
          sourcePrompt: activeSourcePromptRef.current,
          sceneError,
          sceneUrl: activeSceneUrlRef.current,
          currentSceneId,
          retryAction: retryActionRef.current,
        };
        setReviewProposalContext({
          runtimeId: id,
          proposal: outcome,
          sourcePrompt,
          userTurn,
          previous,
          ...(proposalForRequest ? { priorProposal: proposalForRequest } : {}),
        });
        pendingConversationRef.current = null;
        setVerificationReceipt(outcome.verification);
        setResponseDecision(null);
        preparePreview(outcome.decision, id);
        return;
      }
      const decision = outcome;
      const turnMessages: ConversationMessage[] = [
        { role: 'user', content: userTurn },
        { role: 'assistant', content: decision.summary },
      ];

      if (decision.kind === 'clarify') {
        setVerificationReceipt(null);
        setConversation(current => [...current, ...turnMessages].slice(-24));
        setResponseDecision(decision);
        setQuestion(decision.question ?? '');
        setAnswer('');
        setFlow({ kind: 'clarification', message: 'One consequential detail is needed before this experiment can be assembled.' });
      } else if (decision.kind === 'unsupported') {
        setVerificationReceipt(null);
        setConversation(current => [...current, ...turnMessages].slice(-24));
        setResponseDecision(decision);
        setQuestion(decision.question ?? '');
        setAnswer('');
        setFlow({ kind: 'unsupported', message: 'No replacement scene was created. The current preview, if any, is unchanged.' });
      } else if (decision.scene) {
        const document: SceneDocument = { prompt: sourcePrompt, decision, scene: decision.scene };
        pendingConversationRef.current = { runtimeId: id, user: userTurn, summary: decision.summary };
        void saveSceneDocument({ runtimeId: id, document, mode: 'prepare', urlMode: 'push', proposalReplacement: proposalForRequest !== null });
      } else {
        throw new Error('The validated scene decision did not contain a scene.');
      }
    } catch (error) {
      if (id !== generation.current || isAbortError(error)) return;
      requestController.current = null;
      setVerificationReceipt(null);
      setElapsedSeconds(Math.floor((performance.now() - requestStartedAt.current) / 1000));
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
    const proposal = reviewProposalRef.current;
    const proposalPreview = proposal?.runtimeId === experiment.id && !proposal.accepted && !proposal.keeping;
    const restoration = pendingPreviewRestoreRef.current?.runtimeId === experiment.id ? pendingPreviewRestoreRef.current : null;
    const completesProposal = Boolean(proposal && binding && (
      proposal.accepted?.id === binding.saved.id
      || (proposal.keeping && (proposal.previous.savedScene?.id === binding.saved.id || proposal.previous.activeSaved?.saved.id === binding.saved.id))
    ));
    pendingSceneBindingsRef.current.delete(experiment.id);
    activeRef.current = experiment;
    candidateRef.current = null;
    setActiveExperiment(experiment);
    setPendingExperiment(current => current?.id === experiment.id ? null : current);
    setSnapshot(nextSnapshot);
    setResponseDecision(null);
    setBlockedRuntimeId(null);
    clearAfterPauseRef.current = false;

    if (proposalPreview) {
      setBlockedRuntimeId(experiment.id);
      setDescription('');
      setClarifications([]);
      setQuestion('');
      setAnswer('');
      document.title = `${experiment.scene.title} | Physics Lab`;
      if (proposal?.priorProposal) {
        const activeProposal = { ...proposal };
        delete activeProposal.priorProposal;
        setReviewProposalContext(activeProposal);
      }
      setFlow({ kind: 'proposal', message: '' });
      return;
    }

    failedRenewalRef.current = null;
    if (restoration && !binding) {
      pendingPreviewRestoreRef.current = null;
      const previous = restoration.previous;
      const previousSavedId = previous.activeSaved?.saved.id ?? previous.savedScene?.id;
      const activeSaved = activeSavedRef.current?.saved.id === previousSavedId ? activeSavedRef.current : previous.activeSaved;
      activeSavedRef.current = activeSaved ? { ...activeSaved, runtimeId: experiment.id } : null;
      activeSceneUrlRef.current = previous.sceneUrl;
      activeSourcePromptRef.current = previous.sourcePrompt;
      setSavedScene(previous.savedScene);
      setCurrentSceneId(previous.currentSceneId);
      setSceneError(previous.sceneError || 'This setup has no active saved link. Save a new copy before running it.');
      setBlockedRuntimeId(activeSaved ? null : experiment.id);
      retryActionRef.current = previous.retryAction ?? (activeSaved ? null : () => saveCurrentCopy());
    } else if (binding) {
      const liveSaved = activeSavedRef.current;
      const saved = restoration && liveSaved?.saved.id === binding.saved.id ? liveSaved.saved : binding.saved;
      if (restoration) expiryCheckRef.current = '';
      activeSavedRef.current = { runtimeId: experiment.id, saved };
      activeSceneUrlRef.current = saved.id;
      activeSourcePromptRef.current = saved.document.prompt;
      setSavedScene(saved);
      setCurrentSceneId(saved.id);
      setRecentScenes(rememberRecentScene(saved.id, saved.document.scene.title, saved.expiresAt));
      setSceneError('');
      retryActionRef.current = null;
      if (binding.restorePrompt) {
        pendingConversationRef.current = null;
        setConversation([]);
        setAssemblyActivity([]);
        setFormError('');
        setFormErrorDetail('');
        setDescription('');
        setClarifications([]);
        setQuestion('');
        setAnswer('');
      }
      const path = `/scenes/${saved.id}`;
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
    if (restoration || completesProposal || binding?.restorePrompt) {
      pendingPreviewRestoreRef.current = null;
      setReviewProposalContext(null);
    }
    const pendingConversation = pendingConversationRef.current;
    if (!binding?.restorePrompt && pendingConversation?.runtimeId === experiment.id) {
      pendingConversationRef.current = null;
      setConversation(current => [
        ...current,
        { role: 'user' as const, content: pendingConversation.user },
        { role: 'assistant' as const, content: pendingConversation.summary },
      ].slice(-24));
      setDescription('');
      setClarifications([]);
      setQuestion('');
      setAnswer('');
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
    const proposal = reviewProposalRef.current;
    const proposalPreview = proposal?.runtimeId === id && !proposal.accepted && !proposal.keeping;
    const restoration = pendingPreviewRestoreRef.current?.runtimeId === id ? pendingPreviewRestoreRef.current : null;
    pendingSceneBindingsRef.current.delete(id);
    if (pendingConversationRef.current?.runtimeId === id) pendingConversationRef.current = null;
    candidateRef.current = null;
    setPendingExperiment(current => current?.id === id ? null : current);
    setVerificationReceipt(null);
    finishSceneOperation(binding?.operationToken ?? -1);
    setFlow({ kind: 'error', message: 'The paused preview could not be prepared.', detail: message });
    if (proposalPreview) setReviewProposalContext(proposal?.priorProposal ?? null);
    if (restoration) {
      pendingPreviewRestoreRef.current = null;
      if (proposal) {
        const keeping = { ...proposal, keeping: true };
        setReviewProposalContext(keeping);
        retryActionRef.current = () => restorePreviousProposal(keeping);
      }
      setSceneError('The previous setup could not be reopened. Retry to restore it.');
      return;
    }
    if (!binding) {
      if (activeRef.current && !savedScene) {
        setSceneError('This setup has no active saved link. Save a new copy before running it.');
        retryActionRef.current = () => saveCurrentCopy();
      }
      return;
    }
    setSceneError(`The saved scene could not be prepared locally. ${message} Retry without another model request.`);
    const retryMode = binding.urlMode === 'initial' ? 'initial' : 'push';
    const preserveProposal = Boolean(proposal && (
      proposal.accepted?.id === binding.saved.id
      || (proposal.keeping && (proposal.previous.savedScene?.id === binding.saved.id || proposal.previous.activeSaved?.saved.id === binding.saved.id))
    ));
    retryActionRef.current = () => { void loadSavedScene(binding.saved.id, retryMode, preserveProposal); };
    const previousSceneUrlId = activeSavedRef.current?.saved.id ?? activeSceneUrlRef.current;
    if (binding.urlMode === 'pop' && previousSceneUrlId) {
      window.history.replaceState(null, '', `/scenes/${previousSceneUrlId}`);
    }
  };
  const cancelCurrentWork = (message: string) => {
    const candidate = candidateRef.current;
    const binding = candidate ? pendingSceneBindingsRef.current.get(candidate.id) : undefined;
    const restoration = candidate && pendingPreviewRestoreRef.current?.runtimeId === candidate.id;
    const proposal = reviewProposalRef.current;
    invalidateWork(message);
    if (restoration && proposal) {
      pendingPreviewRestoreRef.current = null;
      const keeping = { ...proposal, keeping: true };
      setReviewProposalContext(keeping);
      retryActionRef.current = () => restorePreviousProposal(keeping);
      setSceneError('The previous setup could not be reopened yet. Retry to restore it.');
      return;
    }
    if (!binding) {
      if (activeRef.current && !savedScene && !reviewProposalRef.current) {
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
    retryActionRef.current = () => { void loadSavedScene(binding.saved.id, retryMode, Boolean(
      reviewProposalRef.current && (
        reviewProposalRef.current.accepted?.id === binding.saved.id
        || reviewProposalRef.current.previous.savedScene?.id === binding.saved.id
      ),
    )); };
  };

  function restorePreviousProposal(context: ReviewProposalContext) {
    if (reviewProposalRef.current?.runtimeId !== context.runtimeId) return;
    const previous = context.previous;
    if (!previous.experiment) {
      setReviewProposalContext(null);
      pendingPreviewRestoreRef.current = null;
      clearToHome();
      setDescription(context.sourcePrompt);
      descriptionRef.current?.focus();
      return;
    }
    const original = previous.experiment;
    if (original.decision.kind !== 'scene') return;
    const previousSavedId = previous.activeSaved?.saved.id ?? previous.savedScene?.id;
    const activeSaved = activeSavedRef.current?.saved.id === previousSavedId ? activeSavedRef.current : previous.activeSaved;
    const restoreState: PreviousPreview = { ...previous, activeSaved };
    const id = ++generation.current;
    pendingPreviewRestoreRef.current = { runtimeId: id, previous: restoreState };
    setReviewProposalContext({ ...context, previous: restoreState, keeping: true });
    const saved = restoreState.savedScene && restoreState.activeSaved?.saved.id === restoreState.savedScene.id
      ? restoreState.activeSaved.saved
      : restoreState.savedScene;
    if (saved) pendingSceneBindingsRef.current.set(id, {
      saved,
      urlMode: 'initial',
      operationToken: -1,
      restorePrompt: false,
    });
    setAssemblyProgress(null);
    setVerificationReceipt(null);
    setAssemblyBudget(null);
    setAssemblyActivity([]);
    setElapsedSeconds(0);
    preparePreview(original.decision, id, original.userGroundChoice, original.scene);
    retryActionRef.current = () => restorePreviousProposal({ ...context, previous: restoreState, keeping: true });
  }

  const useReviewProposal = () => {
    const context = reviewProposalRef.current;
    if (!context || activeExperiment?.id !== context.runtimeId || context.accepted || context.keeping
      || isBusy || sceneOperation !== 'idle' || pendingSaveRef.current) return;
    try {
      const scene = validateScene(context.proposal.decision.scene);
      const decision: SceneDecision = { ...context.proposal.decision, scene };
      const document: SceneDocument = { prompt: context.sourcePrompt, decision, scene };
      const id = ++generation.current;
      pendingConversationRef.current = { runtimeId: id, user: context.userTurn, summary: decision.summary };
      void saveSceneDocument({ runtimeId: id, document, mode: 'prepare', urlMode: 'push', proposalReplacement: true });
    } catch (error) {
      setFormError('This setup could not be prepared for saving. No scene was changed.');
      setFormErrorDetail(errorMessage(error));
    }
  };

  const keepPrevious = () => {
    const context = reviewProposalRef.current;
    if (!context || activeExperiment?.id !== context.runtimeId || context.accepted || context.keeping
      || isBusy || sceneOperation !== 'idle') return;
    if (pendingSaveRef.current) invalidateWork('Returning to the previous setup.');
    restorePreviousProposal(context);
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
    if (reviewProposalRef.current?.runtimeId === runtimeId || reviewProposalRef.current?.priorProposal?.runtimeId === runtimeId) return Promise.resolve(false);
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
    if (reviewProposalRef.current?.runtimeId === runtimeId || reviewProposalRef.current?.priorProposal?.runtimeId === runtimeId) return;
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
    else if (activeRef.current && !reviewProposalRef.current && !savedScene && !pendingSaveRef.current && !isBusy && sceneOperation === 'idle') saveCurrentCopy();
  };

  const clearToHome = () => {
    setReviewProposalContext(null);
    pendingPreviewRestoreRef.current = null;
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
      playbackRef.current = null;
      setPlayback(null);
    }
    activeSourcePromptRef.current = '';
    activeRef.current = null;
    activeSceneUrlRef.current = null;
    candidateRef.current = null;
    pendingSceneBindingsRef.current.clear();
    setActiveExperiment(null);
    setPendingExperiment(null);
    setSavedScene(null);
    setCurrentSceneId(null);
    setSnapshot(null);
    setDescription('');
    setConversation([]);
    setClarifications([]);
    setQuestion('');
    setAnswer('');
    setFormError('');
    setFormErrorDetail('');
    setAssemblyProgress(null);
    setVerificationReceipt(null);
    setAssemblyBudget(null);
    setAssemblyActivity([]);
    setResponseDecision(null);
    setBlockedRuntimeId(null);
    setClearCanvasToken(current => current + 1);
    setFlow({ kind: 'idle', message: '' });
    document.title = 'Physics Lab';
  };

  const startExamplePrompt = (prompt: string) => {
    if (examplesUnavailable()) return;
    setExamplesOpen(false);
    if (window.location.pathname !== '/') window.history.pushState(null, '', '/');
    clearToHome();
    setDescription(prompt);
    requestAnimationFrame(() => descriptionRef.current?.focus());
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
        pendingPreviewRestoreRef.current = null;
        invalidateWork('The invalid scene navigation was canceled.');
        operationRef.current = 'idle';
        setSceneOperation('idle');
        setSceneError('This scene link is invalid or unavailable. Start a new experiment at /.');
        const proposal = reviewProposalRef.current;
        if (proposal?.keeping) retryActionRef.current = () => restorePreviousProposal(proposal);
        else if (proposal?.accepted) {
          const acceptedId = proposal.accepted.id;
          retryActionRef.current = () => { void loadSavedScene(acceptedId, 'push', true); };
        } else retryActionRef.current = null;
        const previousSceneUrlId = activeSavedRef.current?.saved.id ?? activeSceneUrlRef.current;
        if (previousSceneUrlId) window.history.replaceState(null, '', `/scenes/${previousSceneUrlId}`);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const interpretation = activeExperiment?.decision ?? null;
  const proposalPreview = reviewProposal && activeExperiment
    ? reviewProposal.runtimeId === activeExperiment.id
      ? reviewProposal
      : reviewProposal.priorProposal?.runtimeId === activeExperiment.id ? reviewProposal.priorProposal : null
    : null;
  const experimentFacts = useMemo(() => {
    const scene = activeExperiment?.scene;
    return scene ? { objects: scene.bodies.length, gravity: Math.hypot(...scene.gravity), ground: scene.ground !== null } : null;
  }, [activeExperiment]);
  const selectableEntities = useMemo(() => new Set(activeExperiment ? [
    ...activeExperiment.scene.bodies.filter(body => body.shape.kind !== 'plane').map(body => body.id),
    ...activeExperiment.scene.tendons.map(tendon => tendon.id),
    ...activeExperiment.scene.connections.map(connection => connection.id),
  ] : []), [activeExperiment]);
  const noProvidersAvailable = config !== null && availableProviders.length === 0;
  const sceneTransitionBusy = sceneOperation === 'loading' || sceneOperation === 'saving';
  const examplesDisabled = examplesUnavailable();
  const canSubmit = !isBusy && !sceneTransitionBusy && !pendingSaveRef.current && !reviewProposal?.accepted && !reviewProposal?.keeping && !configError && provider !== '' && selectedModel.length > 0 && description.trim().length >= 3;


  return (
    <div className="lab-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Physics Lab home" onClick={event => {
          event.preventDefault();
          if (window.location.pathname !== '/') window.history.pushState(null, '', '/');
          clearToHome();
        }}>
          <Atom className="brand__icon" size={22} aria-hidden="true" />
          <span className="brand__name">Physics Lab</span>
          <span className="brand__scope">Mechanics</span>
        </a>
        <div className="service-state" aria-live="polite">
          <span className={`service-state__signal ${config && !configError ? 'is-live' : ''}`} aria-hidden="true" />
          {configError ? 'Lab offline' : config ? 'Lab online' : 'Connecting'}
        </div>
      </header>

      <main id="main" className="mission-board">
        <section className="setup-panel" aria-labelledby="setup-title">
          <div className="setup-panel__heading">
            <div><ChatCircleDots size={22} weight="duotone" aria-hidden="true" /><h1 id="setup-title">Your experiment</h1></div>
          </div>
          <button className="secondary-button examples-trigger" type="button" disabled={examplesDisabled} onClick={() => setExamplesOpen(true)}>
            <BookOpen size={18} aria-hidden="true" /><span className="examples-trigger__label">Examples</span><span className="examples-trigger__count">{EXPERIMENT_EXAMPLES.length}</span>
          </button>
          {conversation.length > 0 ? (
            <section className="conversation-transcript" aria-label="Experiment conversation">
              <ol ref={conversationRef} className="conversation-transcript__messages" role="log" aria-live="polite" aria-relevant="additions">
                {conversation.slice(-8).map((message, index) => (
                  <li className={`conversation-transcript__message conversation-transcript__message--${message.role}`} key={`${message.role}-${index}`}>
                    <details className="chat-message">
                      <summary>
                        <span className="chat-message__author">{message.role === 'user' ? 'You' : 'Lab assistant'}<CaretDown size={13} aria-hidden="true" /></span>
                        <span className="chat-message__text">{message.content}</span>
                      </summary>
                    </details>
                  </li>
                ))}
              </ol>
            </section>
          ) : activeExperiment ? (
            <details className="saved-request response-details">
              <summary><Cube size={16} aria-hidden="true" /><span>{proposalPreview ? 'Request' : 'Saved request'}</span></summary>
              <p>{proposalPreview?.sourcePrompt ?? activeSourcePromptRef.current}</p>
            </details>
          ) : null}

          {assemblyBudget || assemblyProgress || verificationReceipt || flow.kind === 'requesting' ? <AssemblyWork
            ref={progressRef}
            state={flow.kind === 'requesting' ? 'working' : isBusy ? 'preparing' : proposalPreview ? 'proposal' : flow.kind === 'idle' ? 'stopped' : flow.kind}
            progress={assemblyProgress}
            budget={assemblyBudget}
            activity={assemblyActivity}
            verificationReceipt={proposalPreview && !isBusy ? proposalPreview.proposal.verification : verificationReceipt}
            seconds={elapsedSeconds}
            onStop={() => {
              cancelCurrentWork('Stopped. Your message and experiment are unchanged.');
              descriptionRef.current?.focus();
            }}
          /> : null}
          <form className="assembly-form" onSubmit={handleSubmit}>
            <label className="field description-field">
              <span className="field-label">{activeExperiment ? 'What would you like to change?' : 'What would you like to try?'}</span>
              <textarea
                ref={descriptionRef}
                value={description}
                onChange={event => handleDescriptionChange(event.target.value)}
                placeholder={activeExperiment
                  ? 'Change a mass, add an object, or adjust the timing.'
                  : 'Two balls fall from 2 m. One bounces; the other does not.'}
                minLength={3}
                maxLength={16000}
                required
                rows={3}
                aria-describedby="description-hint"
                disabled={Boolean(reviewProposal?.accepted || reviewProposal?.keeping)}
              />
              <span className="field-hint" id="description-hint">{activeExperiment
                ? 'Your current experiment is included.'
                : 'Missing values will be asked for or shown as assumptions.'}</span>
            </label>


            <details className="settings-details">
              <summary className="settings-summary">
                <SlidersHorizontal size={16} aria-hidden="true" /><span className="settings-summary__title">AI settings</span>
                <span className="settings-summary__selection">{selectedProviderLabel || 'Not connected'}</span>
              </summary>
              <div className="settings-content">
                <p className="settings-intro">Your request and experiment go to this service. Each update can use up to {HARNESS_MAX_TURNS} AI requests within {HARNESS_TIMEOUT_MS / 60_000} minutes, including reserved review capacity. No paid alternative is selected automatically.</p>
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
                          {freeModel && freeModel !== OPENROUTER_FREE_ROUTE.id && !models.some(item => item.id === freeModel && item.free)
                            ? <option value={freeModel}>{freeModel} (current selection)</option> : null}
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
                        readOnly={provider === 'openai-codex'}
                        onChange={event => handleModelInput(event.target.value)}
                        maxLength={200}
                        placeholder="Enter a current provider model ID"
                        disabled={!provider || isBusy}
                        required
                      />
                      <span className="field-hint field-hint--warning">{provider === 'openai-codex' ? 'Uses your existing GPT login. Subscription usage limits apply.' : 'Custom model IDs may incur charges. Check your provider’s current pricing.'}</span>
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
                <span className="field-label">A detail is needed</span>
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
                    placeholder="Your answer…"
                  />
                </label>
              </div>
            ) : null}

            {configError ? (
              <div className="notice notice--error" role="alert">
                <p><strong>Couldn’t connect to the lab.</strong> Your draft is kept. Check the connection and try again.</p>
                <button className="secondary-button" type="button" onClick={() => setConfigAttempt(current => current + 1)}>Retry connection</button>
                <details className="diagnostic-details"><summary>Setup details</summary><p>Start the local service with npm run api.</p><p>{configError}</p></details>
              </div>
            ) : null}
            {noProvidersAvailable ? (
              <div className="notice notice--warning" role="status">
                <p><strong>Connect an AI service</strong> to build or edit from a prompt. Examples run without one.</p>
                <details className="diagnostic-details"><summary>Setup instructions</summary><p>The person running this lab needs to add a private OpenRouter, OpenAI or Anthropic API key to the server environment, then restart the lab. Keys never belong in browser code.</p></details>
                <button className="secondary-button" type="button" onClick={() => setConfigAttempt(current => current + 1)}>Check connection</button>
              </div>
            ) : null}
            {formError ? (
              <div className="notice notice--error" role="alert">
                <p>{formError}</p>
                {formErrorDetail ? <details className="diagnostic-details"><summary>Technical details</summary><p>{formErrorDetail}</p></details> : null}
              </div>
            ) : null}

            <div className="submit-row">
              <p className="privacy-note">Up to {HARNESS_MAX_TURNS} AI requests per update. Charges may apply.</p>
              <div className="submit-actions">
                <button className="primary-button" type="submit" disabled={!canSubmit || (question !== '' && answer.trim().length === 0)}>
                  <span>{isBusy ? 'Working…' : flow.kind === 'error' ? 'Try again' : question ? 'Continue' : activeExperiment ? 'Update experiment' : 'Build experiment'}</span>
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
                {flow.kind === 'error' ? <p className="flow-message__next">Your message and experiment are unchanged.</p> : null}
                {flow.kind === 'error' && flow.detail ? <details className="diagnostic-details"><summary>Technical details</summary><p>{flow.detail}</p></details> : null}
              </div>
            </div>
          ) : null}

          {responseDecision && (responseDecision.kind === 'unsupported' || responseDecision.alternative) ? (
            <section className="response-panel response-panel--unsupported" ref={responseRef} tabIndex={-1} aria-labelledby="response-title">
              <h2 id="response-title">{responseDecision.kind === 'unsupported' ? 'This setup needs a change' : 'Suggested setup'}</h2>
              {conversation.at(-1)?.content !== responseDecision.summary ? <p>{responseDecision.summary}</p> : null}
              {responseDecision.alternative ? (
                <div className="response-proposal">
                  <h3>{responseDecision.alternative.label}</h3>
                  <p>{responseDecision.alternative.description}</p>
                  <button className="primary-button" type="button" onClick={() => {
                    handleDescriptionChange(responseDecision.alternative!.description);
                    descriptionRef.current?.focus();
                  }}>Use as draft</button>
                  <small>Review the draft, then send it to build.</small>
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
            <details className="recent-section">
              <summary><ClockCounterClockwise size={16} aria-hidden="true" /><span>Recent scenes</span><span className="recent-count">{recentScenes.length}</span></summary>
              <ul className="recent-list">
                {recentScenes.map(item => (
                  <li key={item.id}>
                    <button
                      className="recent-item"
                      type="button"
                      onClick={() => loadRecentScene(item)}
                      aria-current={!proposalPreview && currentSceneId === item.id ? 'true' : undefined}
                      title="Load the saved scene without a model request"
                    >
                      <strong>{item.title}</strong>
                      {!proposalPreview && currentSceneId === item.id ? <small>Open</small> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
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

        <section className={`simulation-section${activeExperiment?.scene.events.length ? ' simulation-section--scheduled' : ''}`} aria-labelledby="simulation-title">
          <h2 id="simulation-title" className="visually-hidden">Simulation</h2>
          {interpretation?.approximation ? (
            <div className="approximation-notice" role="note">
              <strong>Some behavior is approximated</strong>
              <p>{interpretation.approximation}</p>
            </div>
          ) : null}
          {proposalPreview && !isBusy ? (
            <section className="review-proposal" aria-labelledby="review-proposal-title">
              <div className="review-proposal__heading">
                <span className="review-proposal__badge">Unsaved proposal</span>
                <h2 id="review-proposal-title">Take a look before using this</h2>
              </div>
              <p>The setup passed its initial checks, but the assistant couldn’t settle a few details.</p>
              <p className="field-hint">Run stays disabled until you choose “Use this setup”.</p>
              <details className="review-proposal__concerns">
                <summary>What needs a look</summary>
                <p>These are assistant concerns, not verified facts.</p>
                <ul>
                  {proposalPreview.proposal.concerns.map((concern, index) => (
                    <li key={`${concern.code}-${index}`}>
                      <strong>{Object.hasOwn(REVIEW_CONCERN_CATEGORIES, concern.code) ? REVIEW_CONCERN_CATEGORIES[concern.code] : 'Setup'}</strong>
                      <p>{concern.message}</p>
                    </li>
                  ))}
                </ul>
              </details>
              {proposalPreview.accepted ? (
                <div className="notice notice--warning" role="status">
                  <p>The setup was saved, but its paused preview could not be reopened. {proposalPreview.previous.savedScene ? 'Your previous scene link is unchanged.' : 'No previous scene was replaced.'}</p>
                  <button className="secondary-button" type="button" onClick={retryPersistence}>Retry opening</button>
                </div>
              ) : proposalPreview.keeping ? (
                <div className="notice notice--warning" role="status">
                  <p>{proposalPreview.previous.savedScene ? 'Your previous scene and link are unchanged.' : proposalPreview.previous.experiment ? 'Your previous setup is unchanged.' : 'Nothing new was saved or replaced.'}</p>
                  <button className="secondary-button" type="button" onClick={retryPersistence}>Retry previous setup</button>
                </div>
              ) : pendingSaveRef.current?.mode === 'prepare' && sceneOperation === 'idle' ? (
                <div className="notice notice--warning" role="status">
                  <p>This setup could not be saved yet. {proposalPreview.previous.savedScene ? 'Your previous scene and link are unchanged.' : proposalPreview.previous.experiment ? 'Your previous setup is unchanged.' : 'Nothing has been saved or replaced.'}</p>
                  <button className="secondary-button" type="button" onClick={retryPersistence}>Retry save</button>
                  <button className="secondary-button" type="button" onClick={keepPrevious}>
                    {proposalPreview.previous.experiment ? 'Keep previous' : 'Back to request'}
                  </button>
                </div>
              ) : (
                <div className="review-proposal__actions">
                  <button className="primary-button" type="button" onClick={useReviewProposal} disabled={isBusy || sceneOperation !== 'idle' || pendingSaveRef.current !== null}>Use this setup</button>
                  <button className="secondary-button" type="button" onClick={keepPrevious} disabled={isBusy || sceneOperation !== 'idle'}>
                    {proposalPreview.previous.experiment ? 'Keep previous' : 'Back to request'}
                  </button>
                  <button className="secondary-button" type="button" onClick={() => {
                    descriptionRef.current?.scrollIntoView({ block: 'nearest' });
                    descriptionRef.current?.focus({ preventScroll: true });
                  }} disabled={Boolean(proposalPreview.accepted || proposalPreview.keeping) || sceneOperation !== 'idle'}>
                    Adjust this setup
                  </button>
                </div>
              )}
            </section>
          ) : null}
          {!proposalPreview ? (
            <SceneLinkBar
              saved={pendingSaveRef.current?.mode === 'appearance' ? null : savedScene}
              operation={sceneOperation}
              error={sceneError}
              onRetry={retryPersistence}
              onKeepPreviousLook={pendingSaveRef.current?.mode === 'appearance' ? () => {
                pendingSaveRef.current = null;
                retryActionRef.current = null;
                setSceneError('');
              } : undefined}
              onSaveCopy={activeExperiment && !savedScene && !pendingSaveRef.current && sceneOperation === 'idle' && !isBusy ? saveCurrentCopy : undefined}
            />
          ) : null}
          {activeExperiment ? <SceneTimeline scene={activeExperiment.scene} snapshot={snapshot} /> : null}
          <div className="stage">
            <SimulationCanvas
              experiment={pendingExperiment}
              replacementPending={isBusy || (sceneTransitionBusy && pendingSaveRef.current?.mode !== 'appearance')}
              onStatus={handleCanvasStatus}
              onReady={handleCanvasReady}
              onSnapshot={handleCanvasSnapshot}
              onFailure={handleCanvasFailure}
              onBeforeRun={handleBeforeRun}
              onPlaybackChange={handlePlaybackChange}
              playbackBlocked={blockedRuntimeId === activeExperiment?.id || Boolean(proposalPreview)}
              runToken={generation.current}
              clearToken={clearCanvasToken}
              physicalGround={Boolean(activeExperiment?.scene.ground)}
              groundDisabled={!activeExperiment || Boolean(reviewProposal) || isBusy || sceneTransitionBusy}
              onPhysicalGroundChange={togglePhysicalGround}
              appearance={pendingSaveRef.current?.mode === 'appearance' ? pendingSaveRef.current.document.scene.appearance : activeExperiment?.scene.appearance}
              appearanceDisabled={!activeExperiment || Boolean(reviewProposal) || isBusy || sceneOperation !== 'idle' || pendingSaveRef.current !== null}
              appearanceSaving={sceneOperation === 'saving' && pendingSaveRef.current?.mode === 'appearance'}
              onAppearanceChange={changeAppearance}
              selectedEntityId={selectedEntityId}
              onSelectEntity={setSelectedEntityId}
              onInspectEntity={() => {
                const card = selectedEntityId ? document.getElementById(`object-${selectedEntityId}`) : null;
                card?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
                card?.querySelector<HTMLButtonElement>('.object-select')?.focus({ preventScroll: true });
              }}
            />
          </div>
          {interpretation ? (
            <section className={`interpretation-panel${responseDecision ? ' interpretation-panel--preserved' : ''}`} aria-labelledby="interpretation-title">
              <div className="interpretation-heading">
                <h2 id="interpretation-title">{interpretation.scene?.title ?? 'This scene'}</h2>
                {proposalPreview ? <span className="interpretation-tag">Unsaved proposal</span> : responseDecision ? <span className="interpretation-tag">Unchanged preview</span> : null}
              </div>
              {experimentFacts ? <div className="scene-facts">
                <span><Cube size={15} aria-hidden="true" />{experimentFacts.objects} {experimentFacts.objects === 1 ? 'object' : 'objects'}</span>
                <span><ArrowDown size={15} aria-hidden="true" />{Number(experimentFacts.gravity.toPrecision(4))} m/s²</span>
                <span><Atom size={15} aria-hidden="true" />Ground {experimentFacts.ground ? 'on' : 'off'}</span>
              </div> : null}
              {conversation.at(-1)?.content !== interpretation.summary ? <details className="response-details"><summary>Experiment notes</summary><p>{interpretation.summary}</p></details> : null}
              <div className="interpretation-body">
                {interpretation.assumptions.length > 0 ? (
                  <details className="assumption-list">
                    <summary>Assumptions &amp; details ({interpretation.assumptions.length})</summary>
                    <ul>{interpretation.assumptions.map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}</ul>
                  </details>
                ) : <p className="assumption-empty">No additional assumptions reported.</p>}
                <details className="ground-facts response-details">
                  <summary>Ground details</summary>
                  {activeExperiment && activeExperiment.scene.ground ? (
                    <p className="ground-line">
                      <strong>Ground</strong> at z = {activeExperiment.scene.ground.height} m, restitution {activeExperiment.scene.ground.restitution}, sliding friction {activeExperiment.scene.ground.friction.sliding}.
                    </p>
                  ) : <p className="ground-line"><strong>Ground</strong> off. Modeled supports are listed under Objects.</p>}
                </details>
              </div>
            </section>
          ) : null}
          {activeExperiment || pendingExperiment ? <>
            <TelemetryPanel experimentId={activeExperiment?.id ?? null} snapshot={snapshot} />
            <ObjectCards snapshot={snapshot} hasExperiment selectedEntityId={selectedEntityId} selectableEntities={selectableEntities} onSelectEntity={setSelectedEntityId} />
          </> : null}
        </section>

      </main>
      {examplesOpen ? <ExampleLibrary
        examples={EXPERIMENT_EXAMPLES}
        disabled={examplesDisabled}
        onClose={() => setExamplesOpen(false)}
        onOpenSetup={openExample}
        onStartPrompt={startExamplePrompt}
      /> : null}
      <footer className="page-footer">
        <span>Mechanics only. SI units, Z up. Results are numerical approximations; inspection is read-only.</span>
      </footer>
    </div>
  );
}

