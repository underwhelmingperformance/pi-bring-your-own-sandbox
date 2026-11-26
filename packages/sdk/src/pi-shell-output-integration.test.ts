import type {
	BashOperations,
	ExtensionAPI
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { FixtureConfig } from './fixtures/config.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { shellBackend } from './fixtures/shell-backend.js';
import { initialiseSandboxHost } from './host.js';
import { outsideShellOperations } from './outside-shell-operations.js';
import { createShellOperations } from './pi-shell-operations.js';
import { registerUserShell } from './user-shell.js';

it.each([
	{ route: 'sandbox', dialect: 'bash' },
	{ route: 'sandbox', dialect: 'powershell' },
	{ route: 'user-bash', dialect: 'bash' },
	{ route: 'outside-provider', dialect: 'bash' },
	{ route: 'outside-host', dialect: 'bash' }
] as const)(
	'escapes display controls at the Pi output callback for $route $dialect',
	async ({ route, dialect }) => {
		const ordinary = '\u{1B}[32mfirst\tline\r\n👩\u{200D}💻';
		const raw = '\u{FEFF}\u{202E}\u{85}\u{9B}8m\u{7F}' + ordinary;
		const expected = String.raw`\u{feff}\u{202e}\x85\x9b8m\x7f` + ordinary;
		const bytes = Buffer.from(raw);
		const encoded = [...bytes]
			.map((byte) => String.raw`\x${byte.toString(16).padStart(2, '0')}`)
			.join('');
		const nativeCommand = `printf '%b' '${encoded}'`;
		const { backend: template } = shellBackend();
		const backend: typeof template = {
			...template,
			workspace: { ...template.workspace, defaultShell: 'bash' },
			exec(_request, context) {
				for (const byte of bytes) {
					context.onOutput({ stream: 'stdout', data: Uint8Array.of(byte) });
				}

				return Promise.resolve({
					kind: 'exited',
					exit: { kind: 'code', code: 0 }
				});
			}
		};
		const config = new FixtureConfig();
		let api: ExtensionAPI | undefined;

		config.set({
			provider: 'fixture',
			policy: backend.policy,
			approval: { policy: 'always' },
			outsideSandbox: {
				destination: route === 'outside-provider' ? 'provider' : 'normal'
			}
		});
		await withPiRuntime(
			[
				{
					name: 'fixture',
					factory(pi) {
						api = pi;
						initialiseSandboxHost(pi, import.meta.filename, {});
						config.activate(pi, {
							id: 'fixture',
							label: 'Fixture sandbox',
							capabilities: backend.capabilities,
							policies: {
								workspaceAccess: ['read-write'],
								filesystemScope: ['provider-default'],
								networkAccess: ['provider-default']
							},
							validateConfig: () => ({}),
							open: () => Promise.resolve(backend),
							outsideSandbox: {
								label: 'Fixture outside destination',
								capabilities: backend.capabilities,
								policy: backend.policy,
								open: () => Promise.resolve(backend)
							}
						});
						config.bind(pi);
						registerUserShell(pi);
					}
				}
			],
			async (runtime, errors) => {
				if (api === undefined) {
					throw new Error('The fixture extension did not load.');
				}

				const context = runtime.session.extensionRunner.createContext();
				const chunks: Buffer[] = [];
				let operations: BashOperations | undefined;

				if (route === 'user-bash') {
					const event = await runtime.session.extensionRunner.emitUserBash({
						type: 'user_bash',
						command: 'output',
						excludeFromContext: false,
						cwd: context.cwd
					});

					operations = event?.operations;
				} else if (route === 'sandbox') {
					operations = createShellOperations(api, context, dialect);
				} else {
					operations = outsideShellOperations(
						api,
						context,
						dialect,
						'Check output.'
					);
				}

				if (operations === undefined) {
					throw new Error('Pi did not receive shell operations.');
				}

				const result = await operations.exec(
					route === 'outside-host' ? nativeCommand : 'output',
					context.cwd,
					{
						onData(data) {
							chunks.push(data);
						}
					}
				);

				expect({
					errors,
					result,
					output: Buffer.concat(chunks).toString('utf8'),
					decodedChunks: chunks.map((chunk) => chunk.toString('utf8')).join('')
				}).toStrictEqual({
					errors: [],
					result: { exitCode: 0 },
					output: expected,
					decodedChunks: expected
				});
			}
		);
	}
);
