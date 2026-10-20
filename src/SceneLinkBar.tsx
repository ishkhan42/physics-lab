import { Check, Clock, LinkSimple } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { SavedSceneMetadata } from '../shared/saved-scene.ts';
import './scene-link.css';

export type SceneLinkOperation = 'idle' | 'saving' | 'loading' | 'renewing';
interface SceneLinkBarProps {
  saved: SavedSceneMetadata | null;
  operation: SceneLinkOperation;
  error: string;
  onRetry: () => void;
  onSaveCopy?: () => void;
  onKeepPreviousLook?: () => void;
}
const DEADLINE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const OPERATION_LABELS = {
  idle: 'Saved scene', saving: 'Saving scene', loading: 'Opening scene', renewing: 'Updating retention',
};

export default function SceneLinkBar({ saved, operation, error, onRetry, onSaveCopy, onKeepPreviousLook }: SceneLinkBarProps) {
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const [manualFor, setManualFor] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const manualInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const busy = operation !== 'idle';
  const link = saved ? `${window.location.origin}/scenes/${saved.id}` : '';

  useEffect(() => {
    if (operation === 'loading') panel.current?.scrollIntoView({ block: 'start' });
  }, [operation]);

  useEffect(() => {
    if (!error) return;
    panel.current?.scrollIntoView({ block: 'start' });
    panel.current?.focus({ preventScroll: true });
  }, [error]);

  useEffect(() => {
    if (manualFor === saved?.id) {
      manualInput.current?.focus();
      manualInput.current?.select();
    }
  }, [manualFor, saved?.id]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyLink = async () => {
    if (!saved) return;
    if (!navigator.clipboard?.writeText) {
      setManualFor(saved.id);
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopiedFor(saved.id);
      setManualFor(null);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedFor(null), 2000);
    } catch {
      setManualFor(saved.id);
    }
  };

  if (!saved && !busy && !error) return null;
  return (
    <section className="scene-link-bar" aria-label="Scene link and retention" ref={panel} tabIndex={-1}>
      <div className="scene-link-bar__main">
        <div className="scene-link-bar__metadata">
          <span className="scene-link-bar__state" role="status" aria-live="polite">
            {saved && !busy ? <Check size={16} aria-hidden="true" /> : <LinkSimple size={16} aria-hidden="true" />}
            {busy ? OPERATION_LABELS[operation] : onKeepPreviousLook ? 'Look not saved' : !saved ? 'Scene not available' : 'Saved scene'}
          </span>
          {saved ? (
            <span className="scene-link-bar__expiry">
              <Clock size={14} aria-hidden="true" />
              Expires
              <time dateTime={saved.expiresAt}>{DEADLINE_FORMAT.format(new Date(saved.expiresAt))}</time>
            </span>
          ) : null}
        </div>
        {saved ? (
          <button className="tool-button" type="button" onClick={() => void copyLink()} title="Copy a link to this saved setup, including its prompt and assumptions">
            {copiedFor === saved.id ? <Check size={16} aria-hidden="true" /> : <LinkSimple size={16} aria-hidden="true" />}
            {copiedFor === saved.id ? 'Copied' : 'Copy link'}
          </button>
        ) : null}
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">{saved && copiedFor === saved.id ? 'Scene link copied.' : ''}</span>
      {saved ? <p className="scene-link-bar__help">Link holders can view the prompt and setup. Runs renew the 24-hour retention.</p> : null}
      {saved && manualFor === saved.id ? (
        <label className="field scene-link-bar__manual">
          <span className="field-label">Select and copy this scene link</span>
          <input ref={manualInput} type="text" value={link} readOnly onFocus={event => event.currentTarget.select()} />
        </label>
      ) : null}
      {error ? (
        <div className="scene-link-bar__error" role="alert">
          <p>{error}</p>
          <div className="scene-link-bar__actions">
            <button className="secondary-button" type="button" onClick={onRetry} disabled={busy}>Retry</button>
            {onSaveCopy ? <button className="secondary-button" type="button" onClick={onSaveCopy} disabled={busy}>Save new copy</button> : null}
            {onKeepPreviousLook ? <button className="secondary-button" type="button" onClick={onKeepPreviousLook} disabled={busy}>Keep previous look</button> : null}
            {!saved && !onKeepPreviousLook ? <a className="tool-button" href="/">New experiment</a> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
