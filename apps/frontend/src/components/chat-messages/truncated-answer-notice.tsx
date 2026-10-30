import { ScissorsIcon, StepForwardIcon } from 'lucide-react';
import { Button } from '../ui/button';
import type { UIMessage } from '@nao/backend/chat';
import { useAgentContext, useAgentMessagesSelector } from '@/contexts/agent.provider';
import { cn } from '@/lib/utils';

const CONTINUE_PROMPT = 'Continue the analysis where you stopped.';

export function TruncatedAnswerNotice({ className }: { className?: string }) {
	const { isRunning, isReadonly, queueOrSendMessage } = useAgentContext();
	const isTruncated = useAgentMessagesSelector(isLastAnswerTruncated);

	if (!isTruncated || isRunning || isReadonly) {
		return null;
	}

	return (
		<div className={cn('flex items-start gap-2.5 px-4 py-3 text-muted-foreground', className)}>
			<ScissorsIcon className='size-4 shrink-0 mt-1' />

			<div className='flex-1 min-w-0 text-sm'>
				<p className='leading-relaxed'>The analysis reached the model&apos;s output limit before finishing.</p>
				<Button
					variant='outline'
					size='sm'
					className='mt-3'
					onClick={() => {
						void queueOrSendMessage({ text: CONTINUE_PROMPT });
					}}
				>
					<StepForwardIcon />
					Continue the analysis
				</Button>
			</div>
		</div>
	);
}

function isLastAnswerTruncated(messages: UIMessage[]): boolean {
	const lastMessage = messages.at(-1);
	return lastMessage?.role === 'assistant' && lastMessage.stopReason === 'length';
}
