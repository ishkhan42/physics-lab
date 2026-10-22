import { useEffect, useRef } from 'react';
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
const OPERATION_LABELS = {
  idle: '', saving: 'Saving…', loading: 'Opening the saved experiment…', renewing: 'Extending the link…',
};

// Saving and link problems. The link itself lives in the Share menu.
export default function SceneLinkBar({ saved, operation, error, onRetry, onSaveCopy, onKeepPreviousLook }: SceneLinkBarProps) {
  const panel = useRef<HTMLElement>(null);
  const busy = operation !== 'idle';

  useEffect(() => {
    if (!error) return;
    panel.current?.scrollIntoView({ block: 'nearest' });
    panel.current?.focus({ preventScroll: true });
  }, [error]);

  if (!error && !(busy && operation !== 'saving')) return null;
  return (
    <section className={`scene-notice${error ? ' scene-notice--error' : ''}`} aria-label="Saved experiment" ref={panel} tabIndex={-1}>
      {busy && !error ? <p className="scene-notice__status" role="status"><span className="spinner" aria-hidden="true" />{OPERATION_LABELS[operation]}</p> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <div className="scene-notice__actions">
            <button className="secondary-button" type="button" onClick={onRetry} disabled={busy}>Try again</button>
            {onSaveCopy ? <button className="secondary-button" type="button" onClick={onSaveCopy} disabled={busy}>Save a new copy</button> : null}
            {onKeepPreviousLook ? <button className="secondary-button" type="button" onClick={onKeepPreviousLook} disabled={busy}>Keep the previous look</button> : null}
            {!saved && !onKeepPreviousLook ? <a className="secondary-button" href="/">New experiment</a> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
