import { Atom, CheckCircle, ClockCounterClockwise, Cube, ShieldCheck, Stop, TestTube } from '@phosphor-icons/react';
import type { Ref } from 'react';
import type { AssemblyProgress } from '../shared/assembly-stream.ts';
import { HARNESS_REVIEW_MAX_TURNS, type HarnessBudget } from '../shared/harness.ts';
import type { VerificationReceipt } from '../shared/verification.ts';

export type AssemblyActivity = ({ type: 'progress' } & AssemblyProgress) | { type: 'assistant'; text: string };
type WorkState = 'working' | 'preparing' | 'ready' | 'proposal' | 'stopped' | 'error' | 'clarification' | 'unsupported';
const LABELS: Record<AssemblyProgress['stage'], string> = {
  starting: 'Getting ready', generating: 'Building your experiment', catalog: 'Choosing the right physics',
  validating: 'Checking your setup', simulating: 'Trying the motion', inspecting: 'Looking at your scene',
  repairing: 'Refining after a check', retrying: 'Waiting for your AI service', reviewing: 'Reviewing your experiment',
};
const HINTS: Record<AssemblyProgress['stage'], string> = {
  starting: 'Preparing a private space to work.', generating: 'Working through your objects and conditions.',
  catalog: 'Checking what the lab can model.', validating: 'Checking values and connections.',
  simulating: 'Running a real physics check.', inspecting: 'Inspecting the actual view.',
  repairing: 'Using the check results to improve the setup.', retrying: 'Your current experiment stays unchanged.',
  reviewing: 'Checking that the result matches your request.',
};
const OUTCOMES: Record<Exclude<WorkState, 'working' | 'preparing'>, string> = {
  ready: 'Preview ready', proposal: 'Needs a look', stopped: 'Stopped', error: 'Could not finish', clarification: 'Waiting for you', unsupported: 'Request reviewed',
};
function elapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function AssemblyWork({ state, progress, budget, activity, verificationReceipt, seconds, onStop, ref }: {
  state: WorkState;
  progress: AssemblyProgress | null;
  budget: HarnessBudget | null;
  activity: readonly AssemblyActivity[];
  verificationReceipt?: VerificationReceipt | null;
  seconds: number;
  onStop: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const busy = state === 'working' || state === 'preparing';
  if (!busy && !budget && !(state === 'ready' && verificationReceipt) && !(state === 'proposal' && verificationReceipt)) return null;
  const phase = progress?.role === 'reviewer' || progress?.stage === 'reviewing' ? 'review'
    : progress && ['validating', 'simulating', 'inspecting'].includes(progress.stage) ? 'test' : 'build';
  const title = state === 'preparing' ? 'Opening your preview' : progress?.role === 'reviewer' ? LABELS.reviewing : progress ? LABELS[progress.stage] : 'Getting ready';
  const hint = progress?.stage === 'simulating' ? progress.message : progress ? HINTS[progress.stage] : 'Connecting to your chosen AI service.';
  const history = <>
    {budget ? <p className="assembly-work__limits">{budget.toolCalls} of {budget.toolCallLimit} lab actions used. AI requests include building and review, not a percentage complete.</p> : null}
    {activity.length ? <ol className="assembly-activity">
      {activity.map((item, index) => <li key={`${index}-${item.type}`}>
        <strong>{item.type === 'assistant' ? 'Assistant' : LABELS[item.stage]}{item.type === 'progress' && item.budget && item.budget.modelRequests > 0 ? <span>Request {item.budget.modelRequests}</span> : null}</strong>
        <p>{item.type === 'assistant' ? item.text : item.message}</p>
      </li>)}
    </ol> : <p className="assembly-work__limits">No model activity yet.</p>}
  </>;

  if (!busy) return <div className="assembly-receipt" ref={ref}>
    <details className="assembly-progress__request">
      <summary>
        <span className="assembly-receipt__outcome">{state === 'ready' ? <CheckCircle size={15} aria-hidden="true" /> : <ClockCounterClockwise size={15} aria-hidden="true" />}{OUTCOMES[state]}</span>
        {budget ? <span className="assembly-receipt__count">{budget.modelRequests} AI {budget.modelRequests === 1 ? 'request' : 'requests'} · {elapsed(seconds)}</span> : null}
      </summary>
      <div>
        {state === 'ready' && verificationReceipt ? <p className="assembly-work__limits">Setup and the first {verificationReceipt.checkedThroughSeconds.toFixed(1)} s of motion checked. Further motion runs when you press Run.</p> : null}
        {state === 'proposal' && verificationReceipt ? <p className="assembly-work__limits">The check covered the first {verificationReceipt.checkedThroughSeconds.toFixed(1)} s of motion.</p> : null}
        {history}
      </div>
    </details>
  </div>;

  return <div className="assembly-progress" data-stage={progress?.stage ?? state} ref={ref} tabIndex={-1}>
    <div className="assembly-work__identity"><span><Atom size={16} aria-hidden="true" />Lab assistant</span><output aria-label="Elapsed work time" aria-live="off">{elapsed(seconds)}</output></div>
    <div className="assembly-work__status" role="status" aria-live="polite" aria-atomic="true">
      <strong>{title}</strong>
      <p>{state === 'preparing' ? 'Your scene will open paused, ready to explore.' : hint}</p>
    </div>
    {state !== 'preparing' ? <ol className="assembly-work__phases" aria-label="Current work, checks may repeat">
      <li aria-current={phase === 'build' ? 'step' : undefined}><Cube size={15} aria-hidden="true" />Build</li>
      <li aria-current={phase === 'test' ? 'step' : undefined}><TestTube size={15} aria-hidden="true" />Test</li>
      <li aria-current={phase === 'review' ? 'step' : undefined}><ShieldCheck size={15} aria-hidden="true" />Review</li>
    </ol> : null}
    <div className="assembly-work__budget">
      {budget ? <span><output aria-label="AI requests used" aria-live="off">{budget.modelRequests}<span> / {budget.modelRequestLimit}</span></output><span>AI requests</span></span> : <span className="assembly-work__limits">{state === 'preparing' ? 'Preparing the scene' : 'Waiting for activity'}</span>}
      <button className="secondary-button assembly-work__stop" type="button" onClick={onStop}><Stop size={12} weight="fill" aria-hidden="true" />Stop</button>
    </div>
    {budget && state === 'working' && budget.modelRequestLimit - budget.modelRequests <= HARNESS_REVIEW_MAX_TURNS + 2 ? <p className="assembly-work__limits">{phase === 'review' ? 'Using the remaining requests for review.' : 'Final requests are held for review.'}</p> : null}
    {activity.length || budget ? <details className="assembly-progress__request"><summary>Activity</summary><div>{history}</div></details> : null}
  </div>;
}
