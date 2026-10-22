import { useState } from 'react';
import type { Scene } from '../shared/scene.ts';

const LONG_MESSAGE = 280;
const ASSUMPTION_PREVIEW = 4;
const VALUE_FORMAT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });

export function Bubble({ role, text, label, pending = false, highlight = false }: {
  role: 'user' | 'assistant';
  text: string;
  label?: string;
  pending?: boolean;
  highlight?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > LONG_MESSAGE;
  return (
    <li className={`bubble bubble--${role}${pending ? ' is-pending' : ''}${highlight ? ' is-highlight' : ''}`}>
      {label ? <span className="bubble__label">{label}</span> : <span className="visually-hidden">{role === 'user' ? 'You' : 'Lab assistant'}</span>}
      <p className={long && !expanded ? 'is-clamped' : undefined}>{text}</p>
      {long ? <button className="link-button" type="button" onClick={() => setExpanded(current => !current)}>{expanded ? 'Show less' : 'Show more'}</button> : null}
    </li>
  );
}

export function SceneSummary({ title, tag, scene, assumptions, approximation, groundDisabled, onGroundChange }: {
  title: string;
  tag: string | null;
  scene: Scene;
  assumptions: readonly string[];
  approximation: string | null;
  groundDisabled: boolean;
  onGroundChange: (enabled: boolean) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? assumptions : assumptions.slice(0, ASSUMPTION_PREVIEW);
  const gravity = Math.hypot(...scene.gravity);
  return (
    <section className="panel-section scene-summary" aria-labelledby="scene-title">
      <div className="scene-summary__head">
        <h2 id="scene-title">{title}</h2>
        {tag ? <span className="scene-summary__tag">{tag}</span> : null}
      </div>
      <div className="scene-facts">
        <span>{scene.bodies.length} {scene.bodies.length === 1 ? 'object' : 'objects'}</span>
        <span>g = {VALUE_FORMAT.format(gravity)} m/s²</span>
        <label className="switch" title="Adds or removes a physical floor. The preview is rebuilt without an AI request and gets a new link.">
          <input type="checkbox" role="switch" checked={scene.ground !== null} disabled={groundDisabled} onChange={event => onGroundChange(event.currentTarget.checked)} />
          <span>Ground</span>
        </label>
      </div>
      {scene.ground ? <p className="scene-summary__ground">Ground at {VALUE_FORMAT.format(scene.ground.height)} m · bounciness {VALUE_FORMAT.format(scene.ground.restitution)} · friction {VALUE_FORMAT.format(scene.ground.friction.sliding)}</p> : null}
      {approximation ? (
        <div className="approximation-notice" role="note">
          <strong>Approximated</strong>
          <p>{approximation}</p>
        </div>
      ) : null}
      {assumptions.length > 0 ? (
        <div className="assumptions">
          <h3>What the lab assumed</h3>
          <ul>{shown.map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}</ul>
          {assumptions.length > ASSUMPTION_PREVIEW ? (
            <button className="link-button" type="button" onClick={() => setShowAll(current => !current)}>
              {showAll ? 'Show fewer' : `Show all ${assumptions.length}`}
            </button>
          ) : null}
        </div>
      ) : <p className="assumption-empty">No extra assumptions.</p>}
    </section>
  );
}
