import { BookOpen, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
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
  const [selected, setSelected] = useState<Record<string, string>>({});

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
          <p id="examples-description">Open a prepared setup, or start with its prompt. Opening uses no AI requests.</p>
        </div>
        <button className="tool-button example-library__close" type="button" aria-label="Close examples" onClick={() => dialogRef.current?.close()}><X size={20} aria-hidden="true" /></button>
      </header>
      <div className="example-library__studies">
        {examples.map(example => {
          const setup = example.setups.find(item => item.id === selected[example.id]) ?? example.setups[0];
          return (
            <article className="example-study" key={example.id} aria-labelledby={`example-${example.id}`}>
              <h3 id={`example-${example.id}`}>{example.title}</h3>
              <p className="example-study__question">{example.question}</p>
              {example.setups.length > 1 ? (
                <label className="field">
                  <span className="field-label">Setup</span>
                  <select value={setup.id} aria-label={`${example.title} setup`} onChange={event => setSelected(current => ({ ...current, [example.id]: event.target.value }))}>
                    {example.setups.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
              ) : <p className="example-study__setup">{setup.label}</p>}
              <p className="example-study__note">{setup.note}</p>
              <details className="response-details example-study__prompt">
                <summary>View prompt</summary>
                <p>{setup.document.prompt}</p>
              </details>
              <div className="example-study__actions">
                <button className="primary-button" type="button" disabled={disabled} onClick={() => choose(() => onOpenSetup(setup))}>Open setup</button>
                <button className="secondary-button" type="button" disabled={disabled} onClick={() => choose(() => onStartPrompt(setup.document.prompt))}>Start from prompt</button>
              </div>
            </article>
          );
        })}
      </div>
      <p className="example-library__footer">Open setup starts paused. Start from prompt replaces your draft; nothing is sent until you press Build. Your saved scenes remain.</p>
    </dialog>
  );
}
