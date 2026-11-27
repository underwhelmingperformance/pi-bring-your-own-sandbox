import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { ScriptedModel } from '../../../test-support/scripted-model.js';

import type {
	BackendProcessContext,
	ProcessRequest,
	Profile
} from './contracts.js';
import {
	SandboxPathNotFoundError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { registerFixtureProvider } from './fixtures/register-provider.js';
import sandboxTools from './pi-tools.js';

it.each([
	{ dialect: undefined, probe: 'available' },
	{ dialect: undefined, probe: 'missing' },
	{ dialect: 'sh', probe: 'available' },
	{ dialect: 'sh', probe: 'missing' },
	{ dialect: 'bash', probe: 'available' },
	{ dialect: 'bash', probe: 'unsupported' },
	{ dialect: 'powershell', probe: 'unsupported' }
] as const)(
	'runs target grep with dialect $dialect and probe $probe',
	async ({ dialect, probe }) => {
		const memory = new MemoryBackend();
		const providerId = 'fixture.pi-file-tools';
		const profile: Profile = {
			...memory.profile,
			capabilities: [...memory.profile.capabilities, 'search.grep'],
			processKinds: dialect === undefined ? ['argv'] : ['shell'],
			shells: dialect === undefined ? [] : [dialect]
		};
		const file = 'marker.txt';
		const pattern = "needle's $value";
		const hasNativeGrep = probe === 'available';
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
					pattern,
					literal: true,
					ignoreCase: true,
					glob: '*.txt'
				}
			}))
		);
		const lines = [
			'{"type":"begin","data":{"path":{"text":"marker.txt"}}}',
			JSON.stringify({
				type: 'match',
				data: {
					path: { text: file },
					line_number: 1,
					lines: { text: pattern + '\n' }
				}
			}),
			'{"type":"end","data":{"path":{"text":"marker.txt"},"binary_offset":null}}',
			'{"type":"summary","data":{}}'
		];
		const fixture: InlineExtension = {
			name: 'file-provider',
			factory(pi) {
				registerFixtureProvider(pi, '<inline:file-provider>', {
					id: providerId,
					label: 'File provider',
					profiles: { open: [profile], copy: [] },
					validateConfig: () => ({}),
					open() {
						memory.seed(file, Buffer.from(pattern + '\n'));

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
									request.kind === 'argv'
										? request.args[0] === '--version'
										: request.command === "exec 'rg' '--version'";

								if (isProbe && probe === 'unsupported') {
									return Promise.reject(
										new UnsupportedSandboxCapabilityError({ operation: 'exec' })
									);
								}

								if (isProbe && probe === 'missing' && request.kind === 'argv') {
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
									exit: {
										kind: 'code',
										code: isProbe && probe === 'missing' ? 127 : 0
									}
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
												text: pattern,
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

				const target = memory.workspace.root;
				const expectedProbe =
					dialect === undefined
						? { kind: 'argv', executable: 'rg', args: ['--version'] }
						: { kind: 'shell', dialect, command: "exec 'rg' '--version'" };
				const expectedSearch =
					dialect === undefined
						? {
								kind: 'argv',
								executable: 'rg',
								cwd: target,
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
									pattern,
									file
								]
							}
						: {
								kind: 'shell',
								dialect,
								cwd: target,
								command:
									"exec 'rg' '--no-config' '--json' '--line-number' '--color=never' " +
									"'--hidden' '--ignore-case' '--fixed-strings' '--glob' '*.txt' '--' " +
									"'needle'\\''s $value' 'marker.txt'"
							};

				expect({ errors, requests, portable, results }).toStrictEqual({
					errors: [],
					requests: [
						...(dialect === 'powershell' ? [] : [expectedProbe]),
						...(hasNativeGrep ? searches.map(() => expectedSearch) : [])
					],
					portable: hasNativeGrep
						? []
						: searches.map(() => ({
								pattern,
								path: target + '/' + file,
								literal: true,
								ignoreCase: true,
								glob: '*.txt',
								context: 0,
								limit: 100
							})),
					results: searches.map(() => ({
						isError: false,
						content: [{ type: 'text', text: file + ':1: ' + pattern }]
					}))
				});
			}
		);
	}
);
