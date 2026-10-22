import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessage, JsonObject } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { labModel } from '../server/providers.ts';
import { runDockerSandbox, runSandbox } from '../server/sandbox.ts';
import { HarnessRequestSchema, ModelPurposeSchema } from '../shared/harness.ts';
import { InlineSceneImageSchema, VisualInspectionRequestSchema, MAX_VISUAL_CALLS_PER_RUN, MAX_VISUAL_FRAMES_PER_RUN } from '../shared/visual-inspection.ts';
import { validateDecision } from '../shared/scene.ts';
import { changingWrap, projectile } from './fixtures.ts';

const RequestSchema = z.object({ type: z.literal('model'), id: z.number(), purpose: ModelPurposeSchema, context: z.object({ messages: z.array(z.object({
  role: z.string(), content: z.unknown().optional(),
  toolsAdded: z.array(z.object({ name: z.string() })).optional(),
}).passthrough()) }) });
const ToolResultSchema = z.object({ role: z.literal('toolResult'), toolName: z.string(), isError: z.boolean(), content: z.array(z.unknown()) });
const request = HarnessRequestSchema.parse({ provider: 'openrouter', model: 'example/model', description: 'A moving projectile.' });
const candidate = validateDecision({ kind: 'scene', summary: 'A moving projectile.', assumptions: [], question: null, reason: null, approximation: null, alternative: null, scene: projectile() });
const clarification = { kind: 'clarify', summary: 'A consequential question.', assumptions: [], question: 'Which motion should be compared?', reason: null, scene: null, approximation: null, alternative: null };
function answer(id: number, name: string, args: JsonObject) {
  const message: AssistantMessage = {
    role: 'assistant', api: 'openai-completions', provider: 'openrouter', model: 'example/model',
    content: [{ type: 'toolCall', id: `call_${id}`, name, arguments: args }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp: Date.now(),
  };
  return { type: 'model_event', id, event: { type: 'done', reason: 'toolUse', message } };
}
test('visual inspection frame indices reject negative, fractional, and unsafe values', () => {
  assert.equal(VisualInspectionRequestSchema.safeParse({ frames: [-1] }).success, false);
  assert.equal(VisualInspectionRequestSchema.safeParse({ frames: [1.5] }).success, false);
  assert.equal(VisualInspectionRequestSchema.safeParse({ frames: [Number.MAX_SAFE_INTEGER + 1] }).success, false);
  assert.equal(VisualInspectionRequestSchema.safeParse({ frames: [0] }).success, true);
  assert.equal(VisualInspectionRequestSchema.safeParse({ frames: [1, 2, 3, 4, 5, 6] }).success, false);
});

test('broker inspection flag cannot authorize a text-only model to inspect images', { timeout: 60000 }, async () => {
  let denied = false;
  let completed = false;
  const sandbox = runDockerSandbox({ type: 'init', request, model: labModel('openrouter', 'example/model'), brokerInspection: true }, value => {
    const parsed = RequestSchema.safeParse(value);
    if (!parsed.success) {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'decision') completed = true;
      return;
    }
    const declaredReviewTool = parsed.data.context.messages.some(message => message.toolsAdded?.some(tool => tool.name === 'submit_review'));
    assert.equal(parsed.data.purpose === 'reviewer', declaredReviewTool);
    assert.ok(!parsed.data.context.messages.some(message => message.toolsAdded?.some(tool => tool.name === 'inspect_scene')));
    if (parsed.data.id === 1) sandbox.send(answer(parsed.data.id, 'inspect_scene', { decision: candidate }));
    else {
      denied = parsed.data.context.messages.some(message => {
        const result = ToolResultSchema.safeParse(message);
        return result.success && result.data.toolName === 'inspect_scene' && result.data.isError;
      });
      sandbox.send(answer(parsed.data.id, 'finish_experiment', { decision: clarification }));
    }
  }, new AbortController().signal);
  try { await sandbox.done; assert.equal(denied, true); assert.equal(completed, true); }
  finally { sandbox.stop(); }
});

test('vision models receive real renderer frames and the independent reviewer receives image blocks', { timeout: 120000 }, async () => {
  const model = { ...labModel('openrouter', 'example/model'), input: ['text', 'image'] as ('text' | 'image')[] };
  let toolSeen = false;
  let rendered = false;
  let reviewedImages = false;
  let completed = false;
  const sandbox = runSandbox({ type: 'init', request, model }, value => {
    const parsed = RequestSchema.safeParse(value);
    if (!parsed.success) {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'decision') completed = true;
      return;
    }
    const review = parsed.data.purpose === 'reviewer';
    const declaredTools = parsed.data.context.messages.flatMap(message => message.toolsAdded ?? []).map(tool => tool.name);
    assert.equal(review, declaredTools.includes('submit_review'));
    if (review) {
      assert.deepEqual(declaredTools, ['submit_review']);
      const images = parsed.data.context.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(content => InlineSceneImageSchema.safeParse(content).success);
      assert.equal(images.length, 2);
      reviewedImages = true;
      sandbox.send(answer(parsed.data.id, 'submit_review', { approved: true, findings: [] }));
      return;
    }
    toolSeen ||= parsed.data.context.messages.some(message => message.toolsAdded?.some(tool => tool.name === 'inspect_scene'));
    if (parsed.data.id === 1) {
      sandbox.send(answer(parsed.data.id, 'inspect_scene', { decision: candidate, frames: [0, 30], view: 'overview' }));
    } else {
      const results = parsed.data.context.messages.map(message => ToolResultSchema.safeParse(message));
      const result = results.find(value => value.success && value.data.toolName === 'inspect_scene' && !value.data.isError);
      assert.ok(result?.success);
      const images = result.data.content.map(content => InlineSceneImageSchema.safeParse(content)).filter(image => image.success);
      assert.equal(images.length, 2);
      assert.ok(images[0].success && images[1].success);
      assert.notEqual(images[0].data.data, images[1].data.data, 'moving geometry and real trails must change the rendered frame');
      rendered = true;
      sandbox.send(answer(parsed.data.id, 'finish_experiment', { decision: candidate }));
    }
  }, new AbortController().signal);
  try {
    await sandbox.done;
    assert.equal(toolSeen, true);
    assert.equal(rendered, true);
    assert.equal(reviewedImages, true);
    assert.equal(completed, true);
  } finally { sandbox.stop(); }
});

test('physical repairs can finish after the screenshot allowance is spent without reusing stale images', { timeout: 120000 }, async () => {
  const model = { ...labModel('openrouter', 'example/model'), input: ['text', 'image'] as ('text' | 'image')[] };
  let reviews = 0;
  let completed = false;
  const sandbox = runSandbox({ type: 'init', request, model }, value => {
    const parsed = RequestSchema.safeParse(value);
    if (!parsed.success) {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'decision') completed = true;
      return;
    }
    const review = parsed.data.purpose === 'reviewer';
    const declaredTools = parsed.data.context.messages.flatMap(message => message.toolsAdded ?? []).map(tool => tool.name);
    assert.equal(review, declaredTools.includes('submit_review'));
    if (review) {
      assert.deepEqual(declaredTools, ['submit_review']);
      const images = parsed.data.context.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(content => InlineSceneImageSchema.safeParse(content).success);
      assert.equal(images.length, reviews === 0 ? 3 : reviews === 1 ? MAX_VISUAL_FRAMES_PER_RUN - 3 : 0);
      reviews++;
      sandbox.send(answer(parsed.data.id, 'submit_review', reviews < 3
        ? { approved: false, findings: [{ severity: 'error', code: 'parameter', message: 'Correct the requested mass.' }] }
        : { approved: true, findings: [] }));
    } else {
      if (parsed.data.id === 1) {
        const first = structuredClone(candidate);
        first.scene!.bodies[0].mass = 1;
        sandbox.send(answer(parsed.data.id, 'inspect_scene', { decision: first, frames: [0, 15, 30] }));
        return;
      }
      const next = structuredClone(candidate);
      assert.equal(next.kind, 'scene');
      next.scene!.bodies[0].mass = reviews + 1;
      sandbox.send(answer(parsed.data.id, 'finish_experiment', { decision: next }));
    }
  }, new AbortController().signal);
  try {
    await sandbox.done;
    assert.equal(reviews, 3);
    assert.equal(completed, true);
  } finally { sandbox.stop(); }
});

test('diagnostic inspection can precede a later native failure without approving it or rerunning unchanged physics', { timeout: 120000 }, async () => {
  const model = { ...labModel('openrouter', 'example/model'), input: ['text', 'image'] as ('text' | 'image')[] };
  const singular = validateDecision({ ...candidate, scene: {
    category: 'mechanics', title: 'Approaching point masses', gravity: [0, 0, 0], ground: null,
    bodies: [
      { id: 'left', label: 'Left mass', position: [-0.001, 0, 0], shape: { kind: 'point' }, mass: 1, motion: { kind: 'particle', linearVelocity: [1, 0, 0] } },
      { id: 'right', label: 'Right mass', position: [0.001, 0, 0], shape: { kind: 'point' }, mass: 1, motion: { kind: 'particle', linearVelocity: [-1, 0, 0] } },
    ],
    loads: [{ kind: 'gravity', bodyIds: ['left', 'right'], G: Number.MIN_VALUE }],
  } });
  const renamed = validateDecision({ ...singular, scene: { ...singular.scene!, title: 'Renamed approaching masses' } });
  const repaired = validateDecision({ ...singular, scene: { ...singular.scene!, loads: [] } });
  let builds = 0;
  let nativeRuns = 0;
  let completed = false;
  const sandbox = runSandbox({ type: 'init', request, model }, value => {
    if (typeof value === 'object' && value !== null && 'type' in value) {
      if (value.type === 'progress' && 'stage' in value && value.stage === 'simulating') nativeRuns++;
      if (value.type === 'decision') completed = true;
    }
    const parsed = RequestSchema.safeParse(value);
    if (!parsed.success) return;
    if (parsed.data.purpose === 'reviewer') {
      assert.equal(builds, 4, 'failed native checks must not reach review');
      assert.equal(nativeRuns, 2, 'only the failed model and its physical repair should run');
      sandbox.send(answer(parsed.data.id, 'submit_review', { approved: true, findings: [] }));
      return;
    }
    builds++;
    const results = parsed.data.context.messages.flatMap(message => {
      const result = ToolResultSchema.safeParse(message);
      return result.success ? [result.data] : [];
    });
    if (builds === 1) {
      sandbox.send(answer(parsed.data.id, 'inspect_scene', { decision: singular, frames: [0] }));
    } else if (builds === 2) {
      const inspection = results.find(result => result.toolName === 'inspect_scene');
      assert.ok(inspection && !inspection.isError);
      assert.equal(inspection.content.filter(content => InlineSceneImageSchema.safeParse(content).success).length, 1);
      assert.equal(nativeRuns, 0, 'initial diagnostics must not force a full motion check');
      sandbox.send(answer(parsed.data.id, 'finish_experiment', { decision: singular }));
    } else if (builds === 3) {
      assert.equal(results.filter(result => result.toolName === 'finish_experiment').at(-1)?.isError, true);
      assert.equal(nativeRuns, 1);
      sandbox.send(answer(parsed.data.id, 'finish_experiment', { decision: renamed }));
    } else {
      assert.equal(builds, 4);
      assert.equal(results.filter(result => result.toolName === 'finish_experiment').at(-1)?.isError, true);
      assert.equal(nativeRuns, 1, 'a cosmetic-only retry must reuse the failed check');
      sandbox.send(answer(parsed.data.id, 'finish_experiment', { decision: repaired }));
    }
  }, new AbortController().signal);
  try {
    await sandbox.done;
    assert.equal(completed, true);
    assert.equal(nativeRuns, 2);
  } finally { sandbox.stop(); }
});
test('captures a real native frame beyond the former twenty-second cap', { timeout: 120000 }, async () => {
  const model = { ...labModel('openrouter', 'example/model'), input: ['text', 'image'] as ('text' | 'image')[] };
  let completed = false;
  let reviewed = false;
  const sandbox = runSandbox({ type: 'init', request, model }, value => {
    const parsed = RequestSchema.safeParse(value);
    if (!parsed.success) {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'decision') completed = true;
      return;
    }
    if (parsed.data.purpose === 'reviewer') {
      reviewed = true;
      sandbox.send(answer(parsed.data.id, 'submit_review', { approved: true, findings: [] }));
      return;
    }
    if (parsed.data.id === 1) {
      sandbox.send(answer(parsed.data.id, 'inspect_scene', { decision: candidate, frames: [1201] }));
      return;
    }
    const results = parsed.data.context.messages.map(message => ToolResultSchema.safeParse(message));
    const inspection = results.find(result => result.success && result.data.toolName === 'inspect_scene' && !result.data.isError);
    assert.ok(inspection?.success);
    const summaryBlock = inspection.data.content.map(content => z.object({ type: z.literal('text'), text: z.string() }).safeParse(content))
      .find(result => result.success);
    assert.ok(summaryBlock?.success);
    const summary = z.object({
      remainingImages: z.number(),
      remainingInspectionCalls: z.number(),
      frames: z.array(z.object({ requestedAt: z.number(), simulatedAt: z.number() })),
    }).parse(JSON.parse(summaryBlock.data.text));
    assert.equal(summary.remainingImages, MAX_VISUAL_FRAMES_PER_RUN - 1);
    assert.equal(summary.remainingInspectionCalls, MAX_VISUAL_CALLS_PER_RUN - 1);
    assert.equal(summary.frames[0]?.requestedAt, 1201 / 60);
    assert.ok(summary.frames[0]!.simulatedAt > 20);
    assert.equal(inspection.data.content.filter(content => InlineSceneImageSchema.safeParse(content).success).length, 1);
    sandbox.send(answer(parsed.data.id, 'finish_experiment', { decision: clarification }));
  }, new AbortController().signal);
  try {
    await sandbox.done;
    assert.equal(completed, true);
    assert.equal(reviewed, false);
  } finally { sandbox.stop(); }
});

test('appearance-only edits render fresh ground images without reusing the previous view', { timeout: 120000 }, async () => {
  const model = { ...labModel('openrouter', 'example/model'), input: ['text', 'image'] as ('text' | 'image')[] };
  const scene = { ...projectile(), ground: { height: 0, restitution: 1, friction: { sliding: 0, static: null, rolling: 0, torsional: 0 } } };
  scene.bodies[0] = { ...scene.bodies[0]!, position: [0, 0, 1], motion: { kind: 'free', linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] } };
  const styled = (textured: boolean) => validateDecision({
    ...candidate, scene: { ...scene, appearance: { surface: 'concrete', sky: 'day', textured } },
  });
  let firstImage = '';
  let compared = false;
  const sandbox = runSandbox({ type: 'init', request, model }, value => {
    const parsed = RequestSchema.safeParse(value);
    if (!parsed.success) return;
    assert.equal(parsed.data.purpose, 'builder');
    const id = parsed.data.id;
    if (id > 1) {
      const results = parsed.data.context.messages.map(message => ToolResultSchema.safeParse(message));
      const latest = results.findLast(result => result.success && result.data.toolName === 'inspect_scene');
      assert.ok(latest?.success && !latest.data.isError);
      const images = latest.data.content.map(content => InlineSceneImageSchema.safeParse(content)).filter(result => result.success);
      assert.equal(images.length, 1);
      assert.ok(images[0]?.success);
      if (id === 2) firstImage = images[0].data.data;
      else {
        assert.notEqual(images[0].data.data, firstImage);
        compared = true;
      }
    }
    sandbox.send(id <= 2
      ? answer(id, 'inspect_scene', { decision: styled(id === 1), frames: [0] })
      : answer(id, 'finish_experiment', { decision: clarification }));
  }, new AbortController().signal);
  try {
    await sandbox.done;
    assert.equal(compared, true);
  } finally { sandbox.stop(); }
});

test('tendon visual-only edits refresh actual inspector renders', { timeout: 120000 }, async () => {
  const model = { ...labModel('openrouter', 'example/model'), input: ['text', 'image'] as ('text' | 'image')[] };
  const scene = changingWrap();
  const first = validateDecision({
    ...candidate,
    scene: { ...scene, tendons: scene.tendons.map(tendon => ({
      ...tendon, visual: { wireRadius: 0.006, coilRadius: 0.1, turns: 6, forceScale: 25 },
    })) },
  });
  const second = structuredClone(first);
  second.scene!.tendons[0]!.visual = { wireRadius: 0.02, coilRadius: 0.25, turns: 14, forceScale: 25 };
  let firstImage = '';
  let compared = false;
  const sandbox = runSandbox({ type: 'init', request, model }, value => {
    const parsed = RequestSchema.safeParse(value);
    if (!parsed.success) return;
    assert.equal(parsed.data.purpose, 'builder');
    const id = parsed.data.id;
    if (id > 1) {
      const results = parsed.data.context.messages.map(message => ToolResultSchema.safeParse(message));
      const latest = results.findLast(result => result.success && result.data.toolName === 'inspect_scene');
      assert.ok(latest?.success && !latest.data.isError);
      const images = latest.data.content.map(content => InlineSceneImageSchema.safeParse(content)).filter(result => result.success);
      assert.equal(images.length, 1);
      assert.ok(images[0]?.success);
      if (id === 2) firstImage = images[0].data.data;
      else {
        assert.notEqual(images[0].data.data, firstImage);
        compared = true;
      }
    }
    sandbox.send(id <= 2
      ? answer(id, 'inspect_scene', { decision: id === 1 ? first : second, frames: [0] })
      : answer(id, 'finish_experiment', { decision: clarification }));
  }, new AbortController().signal);
  try {
    await sandbox.done;
    assert.equal(compared, true);
  } finally { sandbox.stop(); }
});
