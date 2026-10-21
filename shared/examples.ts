import rawExamples from './examples.json' with { type: 'json' };
import { validateSceneDocument, type SceneDocument } from './saved-scene.ts';

export interface ExampleSetup {
  id: string;
  label: string;
  document: SceneDocument;
  note: string;
}

export interface ExperimentExample {
  id: string;
  title: string;
  question: string;
  setups: ExampleSetup[];
}

export const EXPERIMENT_EXAMPLES: ExperimentExample[] = rawExamples.map(({ id, title, question, setups }) => ({
  id,
  title,
  question,
  setups: setups.map(({ id: setupId, label, prompt, summary, assumptions, scene, note }) => ({
    id: setupId,
    label,
    document: validateSceneDocument({
      prompt,
      decision: {
        kind: 'scene',
        summary,
        assumptions,
        scene,
        question: null,
        reason: null,
        alternative: null,
        approximation: null,
      },
      scene,
    }),
    note,
  })),
}));
