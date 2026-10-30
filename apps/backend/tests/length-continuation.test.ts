import {
	createUIMessageStream,
	type FinishReason,
	type ModelMessage,
	readUIMessageStream,
	streamText,
	type UIMessage,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import {
	LENGTH_CONTINUATION_PROMPT,
	MAX_LENGTH_CONTINUATIONS,
	streamWithLengthContinuations,
} from '../src/agents/length-continuation';
import { sumTokenUsage } from '../src/utils/ai';

describe('streamWithLengthContinuations', () => {
	it('continues an answer cut off by the output limit in the same message', async () => {
		const run = await runTurn(['length', 'stop']);

		expect(run.model.doStreamCalls).toHaveLength(2);
		expect(run.finishReason).toBe('stop');
		expect(visibleText(run.message)).toBe('part 1 part 2 ');
		expect(JSON.stringify(run.message)).not.toContain(LENGTH_CONTINUATION_PROMPT);

		const continuationPrompt = run.model.doStreamCalls[1].prompt;
		expect(continuationPrompt.at(-2)).toMatchObject({ role: 'assistant' });
		expect(continuationPrompt.at(-1)).toMatchObject({
			role: 'user',
			content: [{ type: 'text', text: LENGTH_CONTINUATION_PROMPT }],
		});
	});

	it('streams answers that fit in the output limit exactly once', async () => {
		const run = await runTurn(['stop']);

		expect(run.model.doStreamCalls).toHaveLength(1);
		expect(run.finishReason).toBe('stop');
		expect(visibleText(run.message)).toBe('part 1 ');
	});

	it('gives up after the maximum number of continuations', async () => {
		const run = await runTurn(Array(MAX_LENGTH_CONTINUATIONS + 2).fill('length'));

		expect(run.model.doStreamCalls).toHaveLength(MAX_LENGTH_CONTINUATIONS + 1);
		expect(run.finishReason).toBe('length');
	});

	it('does not continue once the user stopped the turn', async () => {
		const run = await runTurn(['length', 'stop'], () => true);

		expect(run.model.doStreamCalls).toHaveLength(1);
		expect(run.finishReason).toBe('length');
	});
});

describe('sumTokenUsage', () => {
	it('adds each token count and keeps counts no call reported undefined', () => {
		const usage = {
			inputTotalTokens: 10,
			inputNoCacheTokens: 4,
			inputCacheReadTokens: undefined,
			inputCacheWriteTokens: 0,
			outputTotalTokens: 5,
			outputTextTokens: 3,
			outputReasoningTokens: 2,
			totalTokens: 15,
		};

		expect(sumTokenUsage([usage, usage])).toEqual({
			inputTotalTokens: 20,
			inputNoCacheTokens: 8,
			inputCacheReadTokens: undefined,
			inputCacheWriteTokens: 0,
			outputTotalTokens: 10,
			outputTextTokens: 6,
			outputReasoningTokens: 4,
			totalTokens: 30,
		});
	});
});

async function runTurn(finishReasons: FinishReason[], isAborted = () => false) {
	const model = sequenceModel(finishReasons);
	let finishReason: FinishReason | undefined;
	const stream = createUIMessageStream<UIMessage>({
		execute: async ({ writer }) => {
			writer.write({ type: 'start', messageId: 'assistant-1' });
			finishReason = await streamWithLengthContinuations({
				messages: [{ role: 'user', content: 'Analyse the sales' }] satisfies ModelMessage[],
				writer,
				streamStep: async (messages) => streamText({ model, messages }),
				onError: () => 'error',
				isAborted,
			});
		},
	});

	let message: UIMessage | undefined;
	for await (const update of readUIMessageStream({ stream })) {
		message = update;
	}
	return { model, finishReason, message: message! };
}

function sequenceModel(finishReasons: FinishReason[]) {
	let call = 0;
	return new MockLanguageModelV3({
		doStream: async () => {
			call++;
			const text = `part ${call} `;
			const unified = finishReasons[call - 1];
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: 'stream-start', warnings: [] });
						controller.enqueue({ type: 'text-start', id: '0' });
						controller.enqueue({ type: 'text-delta', id: '0', delta: text });
						controller.enqueue({ type: 'text-end', id: '0' });
						controller.enqueue({
							type: 'finish',
							finishReason: { unified, raw: unified },
							usage: {
								inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
								outputTokens: { total: 1, text: 1, reasoning: undefined },
							},
						});
						controller.close();
					},
				}),
			};
		},
	});
}

function visibleText(message: UIMessage): string {
	return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}
