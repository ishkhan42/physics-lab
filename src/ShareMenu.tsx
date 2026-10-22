import { Check, Export, LinkSimple } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { SavedSceneMetadata } from '../shared/saved-scene.ts';
import Popover from './Popover.tsx';

const DEADLINE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

export default function ShareMenu({ saved }: { saved: SavedSceneMetadata }) {
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const [manualFor, setManualFor] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const manualInput = useRef<HTMLInputElement>(null);
  const link = `${window.location.origin}/scenes/${saved.id}`;

  useEffect(() => {
    if (manualFor === saved.id) {
      manualInput.current?.focus();
      manualInput.current?.select();
    }
  }, [manualFor, saved.id]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyLink = async () => {
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

  const copied = copiedFor === saved.id;
  return (
    <Popover label="Share" text="Share" icon={<Export size={17} aria-hidden="true" />} className="share-menu">
      <h3>Share this experiment</h3>
      <p>Anyone with the link can open it, including the prompt and assumptions.</p>
      <button className="primary-button" type="button" onClick={() => void copyLink()}>
        {copied ? <Check size={16} weight="bold" aria-hidden="true" /> : <LinkSimple size={16} aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy link'}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">{copied ? 'Scene link copied.' : ''}</span>
      {manualFor === saved.id ? (
        <label className="field">
          <span className="field-label">Select and copy this link</span>
          <input ref={manualInput} type="text" value={link} readOnly onFocus={event => event.currentTarget.select()} />
        </label>
      ) : null}
      <p className="share-menu__expiry">
        The link works until <time dateTime={saved.expiresAt}>{DEADLINE_FORMAT.format(new Date(saved.expiresAt))}</time>. Running it again keeps it for another 24 hours from then. Each change gets its own link.
      </p>
    </Popover>
  );
}
