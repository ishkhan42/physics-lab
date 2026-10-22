import { ArrowRight } from '@phosphor-icons/react';
import type { ExampleSetup, ExperimentExample } from '../shared/examples.ts';

// Shown on the empty stage: the prepared examples, one click each.
export default function Welcome({ examples, disabled, onOpen, onBrowse }: {
  examples: readonly ExperimentExample[];
  disabled: boolean;
  onOpen: (setup: ExampleSetup) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="welcome">
      <h2>Describe an experiment, or open one of these.</h2>
      <p>Each one opens paused. Press Run to watch it, then ask for a change.</p>
      <ul className="welcome__grid">
        {examples.map(example => (
          <li key={example.id}>
            <button className="welcome-card" type="button" disabled={disabled} onClick={() => onOpen(example.setups[0])}>
              <img src={new URL(`./assets/examples/${example.id}.webp`, import.meta.url).href} alt="" width={640} height={426} loading="lazy" decoding="async" />
              <span className="welcome-card__title">{example.title}</span>
              <span className="welcome-card__question">{example.question}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="link-button" type="button" onClick={onBrowse} disabled={disabled}>About these examples<ArrowRight size={14} aria-hidden="true" /></button>
    </div>
  );
}
