import { X } from '@phosphor-icons/react';
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
          <h2 id="examples-title">Examples</h2>
          <p id="examples-description">Prepared experiments. Opening one uses no AI requests. Images are frames from the simulator.</p>
        </div>
        <button className="icon-button example-library__close" type="button" aria-label="Close examples" onClick={() => dialogRef.current?.close()}><X size={18} aria-hidden="true" /></button>
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
                  <summary>Prompt</summary>
                  <p className="example-study__setup">{setup.label}</p>
                  <p>{setup.document.prompt}</p>
                </details>
                <div className="example-study__actions">
                  <button className="primary-button" type="button" disabled={disabled} onClick={() => choose(() => onOpenSetup(setup))}>Open</button>
                  <button className="secondary-button" type="button" disabled={disabled} onClick={() => choose(() => onStartPrompt(setup.document.prompt))}>Edit the prompt</button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <p className="example-library__footer">Open loads the prepared setup, paused. Edit the prompt puts its text in the message box so you can change it and build your own version with AI.</p>
    </dialog>
  );
}
