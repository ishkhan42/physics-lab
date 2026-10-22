import { BookOpen, X } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import type { ExampleSetup, ExperimentExample } from '../shared/examples.ts';
import './examples.css';

export default function ExampleLibrary({ examples, disabled, onClose, onOpenSetup, onStartPrompt }: {
  examples: readonly ExperimentExample[];
  disabled: boolean;
  onClose: () => void;
  onOpenSetup: (setup: ExampleSetup) => void;
  onStartPrompt: (prompt: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const choose = (action: () => void) => {
    dialogRef.current?.close();
    action();
  };

  return (
    <dialog className="example-library" ref={dialogRef} aria-labelledby="examples-title" aria-describedby="examples-description" onClose={onClose}>
      <header className="example-library__heading">
        <div>
          <h2 id="examples-title"><BookOpen size={22} aria-hidden="true" />Experiments to explore</h2>
          <p id="examples-description">Previews come from the simulator. Opening a setup uses no AI requests.</p>
        </div>
        <button className="tool-button example-library__close" type="button" aria-label="Close examples" onClick={() => dialogRef.current?.close()}><X size={20} aria-hidden="true" /></button>
      </header>
      <div className="example-library__studies">
        {examples.map(example => {
          const setup = example.setups[0];
          return (
            <article className="example-study" key={example.id} aria-labelledby={`example-${example.id}`}>
              <img className="example-study__preview" src={new URL(`./assets/examples/${example.id}.webp`, import.meta.url).href} alt={`${example.title} during simulation`} width={640} height={426} loading="lazy" decoding="async" />
              <div className="example-study__content">
                <h3 id={`example-${example.id}`}>{example.title}</h3>
                <p className="example-study__question">{example.question}</p>
                <p className="example-study__note">{setup.note}</p>
                <details className="response-details example-study__prompt">
                  <summary>Prompt and setup</summary>
                  <p className="example-study__setup">{setup.label}</p>
                  <p>{setup.document.prompt}</p>
                </details>
                <div className="example-study__actions">
                  <button className="primary-button" type="button" disabled={disabled} onClick={() => choose(() => onOpenSetup(setup))}>Open setup</button>
                  <button className="secondary-button" type="button" disabled={disabled} onClick={() => choose(() => onStartPrompt(setup.document.prompt))}>Start from prompt</button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <p className="example-library__footer">Open setup starts paused. Start from prompt replaces your draft; nothing is sent until you press Build. Your saved scenes remain.</p>
    </dialog>
  );
}
