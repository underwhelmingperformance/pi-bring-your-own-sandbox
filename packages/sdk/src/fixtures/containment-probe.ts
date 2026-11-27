import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createMcpExtension } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { ScriptedModel } from '../../../../test-support/scripted-model.js';
import { getSandbox } from '../client.js';
import { registerSandboxProvider } from '../provider-registration.js';

import { MemoryBackend } from './memory-backend.js';
import { withPiRuntime } from './pi-runtime.js';

export default async function probe(marker: string): Promise<void> {
	const model = new ScriptedModel([
		{ type: 'toolCall', id: 'peer', name: 'peer_read', arguments: {} },
		{
			type: 'toolCall',
			id: 'mcp',
			name: 'mcp__boundary__read_marker',
			arguments: {}
		}
	]);
	const backend = new MemoryBackend();

	await withPiRuntime(
		[
			model.extension,
			{
				name: 'mcp',
				factory: createMcpExtension({
					loadConfig: () => ({
						servers: [],
						errors: [],
						autoEnableCodemode: false
					})
				})
			},
			{
				name: 'peer-extension',
				factory(pi) {
					registerSandboxProvider(pi, import.meta.filename, {
						id: 'fixture',
						label: 'Containment fixture',
						profiles: { open: [backend.profile], copy: [] },
						validateConfig: () => ({}),
						open: () => Promise.resolve(backend)
					});
					pi.registerMcpServer('boundary', {
						command: process.execPath,
						args: [
							fileURLToPath(new URL('marker-mcp-server.ts', import.meta.url)),
							marker
						],
						exposure: 'direct'
					});
					pi.registerTool({
						name: 'peer_read',
						label: 'Peer marker read',
						description: 'Read a controlled host marker directly.',
						parameters: Type.Object({}),
						async execute(_id, _input, _signal, _update, context) {
							const acquired = await getSandbox(pi, context);

							await acquired.files.writeFile(
								'marker',
								new TextEncoder().encode('target-marker')
							);

							let host: string;

							try {
								host = await readFile(marker, 'utf8');
							} catch (error) {
								if (
									!(error instanceof Error) ||
									!('code' in error) ||
									!['EPERM', 'EACCES'].includes(String(error.code))
								) {
									throw error;
								}

								host = 'denied';
							}

							const target = new TextDecoder().decode(
								await acquired.files.readFile('marker')
							);

							return {
								content: [
									{ type: 'text', text: JSON.stringify({ host, target }) }
								],
								details: {}
							};
						}
					});
				}
			}
		],
		async (runtime, errors) => {
			const selected = runtime.session.modelRuntime.getModel(
				'scripted',
				'scripted'
			);

			if (selected === undefined) {
				throw new Error('The probe model is unavailable.');
			}

			await runtime.session.setModel(selected);
			await runtime.session.prompt('Read both controlled markers.');

			const results = model.requests
				.at(1)
				?.messages.filter((message) => message.role === 'toolResult')
				.map(({ content, isError }) => ({ content, isError }));

			process.stdout.write(`${JSON.stringify({ errors, results })}\n`);
		}
	);
}
