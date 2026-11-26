import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { ScriptedModel } from '../../../test-support/scripted-model.js';

import type {
	BackendProcessContext,
	ProcessRequest,
	Profile
} from './contracts.js';
import { SandboxPathNotFoundError } from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import sandboxTools from './pi-tools.js';
import { registerSandboxProvider } from './provider-registration.js';

it.each([true, false])(
	'runs target grep with ripgrep available = %s',
	async (hasNativeGrep) => {
		const memory = new MemoryBackend();
		const providerId = 'fixture.pi-file-tools';
		const profile: Profile = {
			...memory.profile,
			capabilities: [...memory.profile.capabilities, 'search.grep']
		};
		const file = 'marker.txt';
		const requests: ProcessRequest[] = [];
		const portable: unknown[] = [];
		const searches = ['first', 'second'];
		const model = new ScriptedModel(
			searches.map((id) => ({
				type: 'toolCall',
				id,
				name: 'grep',
				arguments: {
					path: file,
					pattern: 'needle',
					literal: true,
					ignoreCase: true,
					glob: '*.txt'
				}
			}))
		);
		const lines = [
			'{"type":"begin","data":{"path":{"text":"marker.txt"}}}',
			'{"type":"match","data":{"path":{"text":"marker.txt"},"line_number":1,"lines":{"text":"needle\\n"}}}',
			'{"type":"end","data":{"path":{"text":"marker.txt"},"binary_offset":null}}',
			'{"type":"summary","data":{}}'
		];
		const fixture: InlineExtension = {
			name: 'file-provider',
			factory(pi) {
				registerSandboxProvider(pi, '<inline:file-provider>', {
					id: providerId,
					label: 'File provider',
					profiles: { open: [profile], copy: [] },
					validateConfig: () => ({}),
					open() {
						memory.seed(file, Buffer.from('needle\n'));

						return Promise.resolve({
							id: memory.id,
							workspace: memory.workspace,
							profile,
							policyDescription: memory.policyDescription,
							recovery: memory.recovery,
							...(memory.files !== undefined && { files: memory.files }),
							exec(request: ProcessRequest, context: BackendProcessContext) {
								requests.push(request);

								const isProbe =
									request.kind === 'argv' && request.args[0] === '--version';

								if (isProbe && !hasNativeGrep) {
									return Promise.reject(
										new SandboxPathNotFoundError({ operation: 'exec' })
									);
								}

								if (!isProbe) {
									const data = Buffer.from(lines.join('\n') + '\n');

									context.onOutput({ stream: 'stdout', data });
								}

								return Promise.resolve({
									kind: 'exited',
									exit: { kind: 'code', code: 0 }
								} as const);
							},
							search: {
								grep(request) {
									portable.push(request);

									return Promise.resolve({
										matches: [
											{
												path: file,
												line: 1,
												text: 'needle',
												before: [],
												after: []
											}
										],
										truncated: false
									});
								}
							},
							dispose: memory.dispose.bind(memory)
						});
					}
				});
			}
		};

		await withPiRuntime(
			[
				fixture,
				{
					name: 'sandbox-tools',
					factory(pi) {
						sandboxTools(pi, '<inline:sandbox-tools>');
					}
				},
				model.extension
			],
			async (runtime, errors) => {
				runtime.session.agent.toolExecution = 'sequential';
				runtime.session.setActiveToolsByName(['grep']);

				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

				await runtime.session.setModel(selected);
				await runtime.session.prompt('Search the target marker.');

				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map(({ isError, content }) => ({ isError, content }));

				expect({ errors, requests, portable, results }).toStrictEqual({
					errors: [],
					requests: [
						{ kind: 'argv', executable: 'rg', args: ['--version'] },
						...(hasNativeGrep
							? searches.map(() => ({
									kind: 'argv',
									executable: 'rg',
									cwd: memory.workspace.root,
									args: [
										'--no-config',
										'--json',
										'--line-number',
										'--color=never',
										'--hidden',
										'--ignore-case',
										'--fixed-strings',
										'--glob',
										'*.txt',
										'--',
										'needle',
										file
									]
								}))
							: [])
					],
					portable: hasNativeGrep
						? []
						: searches.map(() => ({
								pattern: 'needle',
								path: memory.workspace.root + '/' + file,
								literal: true,
								ignoreCase: true,
								glob: '*.txt',
								context: 0,
								limit: 100
							})),
					results: searches.map(() => ({
						isError: false,
						content: [{ type: 'text', text: file + ':1: needle' }]
					}))
				});
			}
		);
	}
);
