import { Check, Palette, X } from '@phosphor-icons/react';
import { useEffect, useId, useRef } from 'react';
import { SKY_PRESETS, SURFACE_PRESETS, type Appearance } from '../shared/appearance.ts';
import { SURFACE_PREVIEWS } from './environment.ts';

interface AppearanceControlsProps {
  value: Appearance;
  onChange: (appearance: Appearance) => void;
  disabled: boolean;
  saving: boolean;
}

export default function AppearanceControls({ value, onChange, disabled, saving }: AppearanceControlsProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const id = useId();
  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      const details = detailsRef.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        details.open = false;
        details.querySelector('summary')?.focus();
      } else if (event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close, true);
    };
  }, []);

  return <details className="appearance-controls" ref={detailsRef}>
    <summary className="icon-button" aria-label="Scene appearance" title="Appearance">
      <Palette size={18} aria-hidden="true" />
    </summary>
    <div className="appearance-panel" role="group" aria-labelledby={`${id}-title`}>
      <div className="appearance-heading">
        <h3 id={`${id}-title`}>Appearance</h3>
        <button type="button" className="appearance-close" aria-label="Close appearance" onClick={() => {
          if (detailsRef.current) detailsRef.current.open = false;
          detailsRef.current?.querySelector('summary')?.focus();
        }}><X size={17} aria-hidden="true" /></button>
      </div>
      <fieldset disabled={disabled}>
        <legend>Surface</legend>
        <div className="surface-presets">
          {SURFACE_PRESETS.map(preset => <button key={preset.id} type="button" className="appearance-preset" aria-pressed={value.surface === preset.id} onClick={() => onChange({ ...value, surface: preset.id })}>
            <span className={`surface-preview surface-preview--${preset.id}`} style={SURFACE_PREVIEWS[preset.id] ? { backgroundImage: `url(${SURFACE_PREVIEWS[preset.id]})` } : undefined} aria-hidden="true">
              {value.surface === preset.id ? <span className="preset-check"><Check size={12} weight="bold" /></span> : null}
            </span>
            <span>{preset.label}</span>
          </button>)}
        </div>
        <label className="appearance-texture-toggle physical-ground-toggle">
          <span>Surface texture</span>
          <input type="checkbox" role="switch" checked={value.textured} onChange={event => onChange({ ...value, textured: event.currentTarget.checked })} />
        </label>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Sky &amp; light</legend>
        <div className="sky-presets">
          {SKY_PRESETS.map(preset => <button key={preset.id} type="button" className="appearance-preset" aria-pressed={value.sky === preset.id} onClick={() => onChange({ ...value, sky: preset.id })}>
            <span className={`sky-preview sky-preview--${preset.id}`} aria-hidden="true">
              {value.sky === preset.id ? <span className="preset-check"><Check size={12} weight="bold" /></span> : null}
            </span>
            <span>{preset.label}</span>
          </button>)}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Guides</legend>
        <label className="appearance-texture-toggle physical-ground-toggle">
          <span>Reference grid</span>
          <input type="checkbox" role="switch" checked={value.grid} onChange={event => onChange({ ...value, grid: event.currentTarget.checked })} />
        </label>
      </fieldset>
      <p className="appearance-note" role="status">{saving ? 'Saving this look…' : 'Changes how it looks, not how it moves.'}</p>
    </div>
  </details>;
}
