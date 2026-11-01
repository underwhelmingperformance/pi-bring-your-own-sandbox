import type {
	AssistantMessage,
	ToolCall,
	TranscriptContext
} from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';

export class ScriptedModel {
	readonly requests: TranscriptContext[] = [];
	readonly extension: InlineExtension;

	constructor(
		calls: readonly ToolCall[],
		options?: { readonly providerId?: string; readonly response?: string }
	) {
		const providerId = options?.providerId ?? 'scripted';

		this.extension = {
			name: 'scripted-model',
			factory: (pi) => {
				pi.registerProvider(providerId, {
					api: `${providerId}-api`,
					baseUrl: 'https://scripted.invalid',
					apiKey: 'test-only',
					models: [
						{
							id: providerId,
							name: 'Scripted fixture',
							reasoning: false,
							input: ['text'],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 32_000,
							maxTokens: 1024
						}
					],
					streamSimple: (model, context) => {
						this.requests.push(structuredClone(context));

						if (this.requests.length > 2) {
							throw new Error(
								'Pi requested more turns than the scripted model provides.'
							);
						}

						const isFirst = this.requests.length === 1 && calls.length > 0;
						const message: AssistantMessage = {
							role: 'assistant',
							api: model.api,
							provider: model.provider,
							model: model.id,
							content: isFirst
								? structuredClone([...calls])
								: [{ type: 'text', text: options?.response ?? 'Finished.' }],
							stopReason: isFirst ? 'toolUse' : 'stop',
							timestamp: 0,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0
								}
							}
						};
						const stream = createAssistantMessageEventStream();

						stream.push({
							type: 'start',
							partial: { ...message, content: [] }
						});

						for (const [contentIndex, block] of message.content.entries()) {
							if (block.type === 'toolCall') {
								stream.push({
									type: 'toolcall_start',
									contentIndex,
									partial: message
								});
								stream.push({
									type: 'toolcall_end',
									contentIndex,
									toolCall: block,
									partial: message
								});
							}

							if (block.type !== 'text') {
								continue;
							}

							stream.push({
								type: 'text_start',
								contentIndex,
								partial: message
							});
							stream.push({
								type: 'text_delta',
								contentIndex,
								delta: block.text,
								partial: message
							});
							stream.push({
								type: 'text_end',
								contentIndex,
								content: block.text,
								partial: message
							});
						}

						stream.push({
							type: 'done',
							reason: isFirst ? 'toolUse' : 'stop',
							message
						});

						return stream;
					}
				});
			}
		};
	}
}
