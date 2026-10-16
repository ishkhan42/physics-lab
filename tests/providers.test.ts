import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractAnthropicText,
  extractOpenAIText,
  extractOpenRouterText,
  parseDecisionText,
  ProviderError,
} from '../server/providers.ts';

const validClarification = {
  kind: 'clarify',
  summary: 'The launch speed changes the requested trajectory.',
  assumptions: [],
  question: 'What is the initial speed?',
  reason: null,
  scene: null,
};

function assertProviderError(action: () => unknown, code: string): void {
  assert.throws(action, error => error instanceof ProviderError && error.code === code);
}

test('OpenAI extracts only completed assistant output_text blocks', () => {
  const text = JSON.stringify(validClarification);
  assert.equal(extractOpenAIText({
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: text.slice(0, 20) },
        { type: 'output_text', text: text.slice(20) },
      ] },
    ],
  }), text);
});

test('OpenAI rejects incomplete responses and refusal blocks', () => {
  assertProviderError(() => extractOpenAIText({
    status: 'incomplete',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] }],
  }), 'invalid_provider_response');
  assertProviderError(() => extractOpenAIText({
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: '{}' }] }],
  }), 'invalid_provider_response');
  assertProviderError(() => extractOpenAIText({
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Cannot help.' }] }],
  }), 'model_refusal');
});

test('Anthropic accepts end_turn text and rejects refusal, tool use and token truncation', () => {
  const text = JSON.stringify(validClarification);
  assert.equal(extractAnthropicText({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: text.slice(0, 30) }, { type: 'text', text: text.slice(30) }],
  }), text);
  assertProviderError(() => extractAnthropicText({ stop_reason: 'refusal', content: [{ type: 'text', text: 'No.' }] }), 'model_refusal');
  assertProviderError(() => extractAnthropicText({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x' }] }), 'invalid_provider_response');
  assertProviderError(() => extractAnthropicText({ stop_reason: 'max_tokens', content: [{ type: 'text', text }] }), 'invalid_provider_response');
});

test('OpenRouter requires a completed text choice and rejects refusal or truncation', () => {
  const content = JSON.stringify(validClarification);
  assertProviderError(() => extractOpenRouterText({
    choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: content }] } }],
  }), 'invalid_provider_response');
  assertProviderError(() => extractOpenRouterText({
    choices: [{ finish_reason: 'length', message: { content } }],
  }), 'invalid_provider_response');
  assertProviderError(() => extractOpenRouterText({
    choices: [{ finish_reason: 'stop', message: { refusal: 'Cannot help.', content: null } }],
  }), 'model_refusal');
});

test('model JSON must be complete and pass the semantic decision contract', () => {
  assertProviderError(() => parseDecisionText('{"kind":"clarify"'), 'invalid_model_response');
  assertProviderError(() => parseDecisionText(JSON.stringify({ ...validClarification, question: null })), 'invalid_model_response');
  assertProviderError(() => parseDecisionText(JSON.stringify({ ...validClarification, extra: true })), 'invalid_model_response');
});
