import type { FinishReason, ModelMessage, StreamTextResult, ToolSet, UIMessage, UIMessageStreamWriter } from 'ai';

/** Extra model calls allowed after the answer hits the output token limit, so one turn can write up to three times the cap. */
export const MAX_LENGTH_CONTINUATIONS = 2;

export const LENGTH_CONTINUATION_PROMPT =
	'Your previous response was cut off because it reached the output token limit. ' +
	'Continue exactly where you stopped, without repeating anything you already wrote.';

interface LengthContinuationOptions<TOOLS extends ToolSet, MESSAGE extends UIMessage> {
	messages: ModelMessage[];
	writer: UIMessageStreamWriter<MESSAGE>;
	streamStep: (messages: ModelMessage[]) => Promise<StreamTextResult<TOOLS, never>>;
	onError: (error: unknown) => string;
	isAborted: () => boolean;
	onResult?: (result: StreamTextResult<TOOLS, never>) => void;
}

/**
 * Streams the agent answer into the current UI message and, when it stops on the output token limit,
 * asks the model to continue with a hidden prompt so the user sees one uninterrupted answer.
 */
export async function streamWithLengthContinuations<TOOLS extends ToolSet, MESSAGE extends UIMessage>(
	options: LengthContinuationOptions<TOOLS, MESSAGE>,
): Promise<FinishReason | undefined> {
	let messages = options.messages;
	let finishReason: FinishReason | undefined;

	for (let attempt = 0; attempt <= MAX_LENGTH_CONTINUATIONS; attempt++) {
		const result = await options.streamStep(messages);
		options.onResult?.(result);
		await writeUIStream(options.writer, result, options.onError);

		finishReason = await getFinishReason(result);
		if (finishReason !== 'length' || attempt === MAX_LENGTH_CONTINUATIONS || options.isAborted()) {
			break;
		}
		messages = [...messages, ...(await result.response).messages, buildContinuationMessage()];
	}

	options.writer.write({ type: 'finish', finishReason });
	return finishReason;
}

async function writeUIStream<TOOLS extends ToolSet, MESSAGE extends UIMessage>(
	writer: UIMessageStreamWriter<MESSAGE>,
	result: StreamTextResult<TOOLS, never>,
	onError: (error: unknown) => string,
): Promise<void> {
	const stream = result.toUIMessageStream<MESSAGE>({ sendStart: false, sendFinish: false, onError });
	for await (const chunk of stream) {
		writer.write(chunk);
	}
}

async function getFinishReason<TOOLS extends ToolSet>(
	result: StreamTextResult<TOOLS, never>,
): Promise<FinishReason | undefined> {
	try {
		return await result.finishReason;
	} catch {
		return undefined;
	}
}

function buildContinuationMessage(): ModelMessage {
	return { role: 'user', content: LENGTH_CONTINUATION_PROMPT };
}
