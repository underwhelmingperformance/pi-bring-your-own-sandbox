import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	AgentSessionRuntime,
	EditToolInput,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import type { SandboxBackend, SandboxOperation } from './contracts.js';
import { SandboxPermissionDeniedError } from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { registerFixtureProvider } from './fixtures/register-provider.js';
import sandboxTools from './pi-tools.js';
import { defaultPolicy } from './policy-model.js';

const filename = 'route.txt';
const hostText = 'host fixture\n';
const targetText = 'target fixture\n';
const pixel =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

const extension: InlineExtension = {
	name: 'sandbox-tools',
	factory(pi) {
		sandboxTools(pi, '<inline:sandbox-tools>');
	}
};

function fileProvider(backend: SandboxBackend): InlineExtension {
	return {
		name: 'file-provider',
		factory(pi) {
			registerFixtureProvider(pi, '<inline:file-provider>', {
				id: 'fixture.pi-file-operations',
				label: 'File operation fixture',
				profiles: { open: [backend.profile], copy: [] },
				validateConfig: () => ({}),
				open: ({ hostUserDataRoots }) =>
					Promise.resolve(
						hostUserDataRoots === undefined
							? backend
							: { ...backend, hostUserDataRoots }
					)
			});
		}
	};
}

async function executeTool(
	runtime: AgentSessionRuntime,
	name: string,
	input: Record<string, unknown>
) {
	const runner = runtime.session.extensionRunner;
	const tool = runner
		.getAllRegisteredTools()
		.find(({ definition }) => definition.name === name);

	if (tool === undefined) {
		throw new Error('The file tool was not registered.');
	}

	const toolCallId = 'file-operation';

	runtime.session.setActiveToolsByName([name]);
	await runner.emit({
		type: 'tool_execution_start',
		toolCallId,
		toolName: name,
		args: input
	});

	return tool.definition.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		runner.createToolContext(toolCallId, undefined)
	);
}

it.each([
	{
		tool: 'read',
		input: { path: filename },
		result: targetText,
		image: undefined,
		calls: ['readFile'],
		contents: targetText
	},
	{
		tool: 'read',
		input: { path: filename },
		result: 'Read image file [image/png]',
		image: 'image/png',
		calls: ['readFile'],
		contents: undefined
	},
	{
		tool: 'write',
		input: { path: filename, content: 'remote write\n' },
		result: 'Successfully wrote to route.txt',
		image: undefined,
		calls: ['writeFile'],
		contents: 'remote write\n'
	},
	{
		tool: 'edit',
		input: {
			path: filename,
			edits: [{ oldText: 'target fixture', newText: 'remote edit' }]
		},
		result: 'Successfully replaced 1 block(s) in route.txt.',
		image: undefined,
		calls: ['readFile', 'writeFile'],
		contents: 'remote edit\n'
	},
	{
		tool: 'ls',
		input: { path: '.' },
		result: 'route.txt\ntarget-only.txt',
		image: undefined,
		calls: ['listDirectory'],
		contents: targetText
	},
	{
		tool: 'find',
		input: { pattern: 'target-*.txt' },
		result: 'target-only.txt',
		image: undefined,
		calls: ['find'],
		contents: targetText
	}
])(
	'routes $tool through the broker (image $image)',
	async ({ tool, input, result, image, calls, contents }) => {
		const memory = new MemoryBackend();
		const files = memory.files;
		const list = files?.list;

		if (list === undefined) {
			throw new Error('The fixture needs a directory reader.');
		}

		memory.seed(
			filename,
			image === undefined
				? Buffer.from(targetText)
				: Buffer.from(pixel, 'base64')
		);
		memory.seed('target-only.txt', Buffer.from('target only'));

		const backend: SandboxBackend = {
			id: memory.id,
			workspace: memory.workspace,
			profile: {
				...memory.profile,
				capabilities: [...memory.profile.capabilities, 'search.find']
			},
			policyDescription: memory.policyDescription,
			recovery: memory.recovery,
			exec: memory.exec.bind(memory),
			files: {
				...files,
				list: {
					...list,
					listDirectory(filename, context) {
						memory.calls.push({ operation: 'listDirectory', path: filename });

						return list.listDirectory(filename, context);
					}
				}
			},
			search: {
				find(request) {
					memory.calls.push({
						operation: 'find',
						path: request.path ?? memory.workspace.root
					});

					return Promise.resolve({
						paths:
							request.pattern === 'target-*.txt' ? ['target-only.txt'] : [],
						truncated: false
					});
				}
			},
			dispose: memory.dispose.bind(memory)
		};

		await withPiRuntime(
			[fileProvider(backend), extension],
			async (runtime, errors) => {
				const output = await executeTool(runtime, tool, input);
				const hostWorkspace = runtime.session.sessionManager.getCwd();
				const remotePath = ['ls', 'find'].includes(tool)
					? memory.workspace.root
					: path.posix.join(memory.workspace.root, filename);
				const bytes = memory.bytes(filename);

				expect({
					errors,
					content:
						image === undefined
							? output.content
							: output.content.map((block) =>
									block.type === 'text'
										? { ...block, text: block.text.split('\n', 1)[0] }
										: block
								),
					calls: memory.calls,
					host: await readFile(path.join(hostWorkspace, filename), 'utf8'),
					target:
						bytes === undefined
							? undefined
							: Buffer.from(bytes).toString(
									image === undefined ? 'utf8' : 'base64'
								)
				}).toStrictEqual({
					errors: [],
					content: [
						{ type: 'text', text: result },
						...(image === undefined
							? []
							: [{ type: 'image', mimeType: image, data: pixel }])
					],
					calls: calls.map((operation) => ({ operation, path: remotePath })),
					host: hostText,
					target: image === undefined ? contents : pixel
				});
			},
			{ prepare: (cwd) => writeFile(path.join(cwd, filename), hostText) }
		);
	}
);

it('refuses to route a read to a copied workspace', async () => {
	const memory = new MemoryBackend();
	const backend: SandboxBackend = {
		id: memory.id,
		workspace: { ...memory.workspace, relationship: 'copied' },
		profile: memory.profile,
		policyDescription: memory.policyDescription,
		recovery: memory.recovery,
		exec: memory.exec.bind(memory),
		...(memory.files !== undefined && { files: memory.files }),
		dispose: memory.dispose.bind(memory)
	};

	await withPiRuntime([fileProvider(backend), extension], async (runtime) => {
		await expect(
			executeTool(runtime, 'read', { path: filename })
		).rejects.toMatchObject({
			name: 'InvalidSandboxDeclarationError',
			detail: { kind: 'declaration', field: 'workspace.relationship' }
		});
		expect(memory.calls).toStrictEqual([]);
	});
});

async function withCredentialFixture(
	exercise: (
		runtime: AgentSessionRuntime,
		fixture: {
			readonly filename: string;
			readonly marker: string;
			readonly attempts: readonly {
				readonly operation: SandboxOperation;
				readonly path: string;
			}[];
		}
	) => Promise<void>
): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), 'byos-pi-home-'));

	try {
		const memory = new MemoryBackend();
		const read = memory.files?.read;

		if (read === undefined) {
			throw new Error('The fixture needs a file reader.');
		}

		const home = await realpath(directory);
		const filename = path.join(home, '.ssh', 'id_ed25519');
		const marker = 'synthetic credential marker';
		const attempts: { operation: SandboxOperation; path: string }[] = [];

		await mkdir(path.dirname(filename));
		await writeFile(filename, `replace me\n${marker}\n`);
		vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home);

		function denyCredential(operation: SandboxOperation, target: string): void {
			attempts.push({ operation, path: target });

			if (target === filename) {
				throw new SandboxPermissionDeniedError({ operation });
			}
		}

		const backend: SandboxBackend = {
			id: memory.id,
			workspace: {
				...memory.workspace,
				home: '/remote/home',
				hostUserDataRoot: home
			},
			profile: { ...memory.profile, policy: defaultPolicy },
			policyDescription: memory.policyDescription,
			recovery: memory.recovery,
			exec: memory.exec.bind(memory),
			files: {
				...memory.files,
				read: {
					access(target, context) {
						denyCredential('access', target);

						return read.access(target, context);
					},
					stat(target, context) {
						denyCredential('stat', target);

						return read.stat(target, context);
					},
					readFile(target, context) {
						denyCredential('readFile', target);

						return read.readFile(target, context);
					}
				}
			},
			dispose: memory.dispose.bind(memory)
		};

		await withPiRuntime([fileProvider(backend), extension], (runtime) =>
			exercise(runtime, { filename, marker, attempts })
		);
	} finally {
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	}
}

it.each([
	{ tool: 'read', operation: 'access', arguments: {} },
	{ tool: 'grep', operation: 'stat', arguments: { pattern: 'marker' } }
])(
	'refuses $tool on a host credential path under the default policy',
	async (scenario) => {
		await withCredentialFixture(async (runtime, fixture) => {
			const result = executeTool(runtime, scenario.tool, {
				...scenario.arguments,
				path: '~/.ssh/id_ed25519'
			});

			await expect(result).rejects.toMatchObject({
				name: 'SandboxPermissionDeniedError',
				operation: scenario.operation
			});
			expect({
				attempts: fixture.attempts,
				host: await readFile(fixture.filename, 'utf8')
			}).toStrictEqual({
				attempts: [{ operation: scenario.operation, path: fixture.filename }],
				host: `replace me\n${fixture.marker}\n`
			});
		});
	}
);

async function renderedEditPreview(
	runtime: AgentSessionRuntime,
	arguments_: EditToolInput
): Promise<string> {
	const runner = runtime.session.extensionRunner;
	const tool = runner
		.getAllRegisteredTools()
		.find(({ definition }) => definition.name === 'edit');
	const render = tool?.definition.renderCall;

	if (render === undefined) {
		throw new Error('The edit call renderer was not registered.');
	}

	initTheme('dark', false);

	const updated = Promise.withResolvers<undefined>();
	const context = {
		args: arguments_,
		toolCallId: 'edit-preview',
		invalidate() {
			updated.resolve(undefined);
		},
		lastComponent: undefined,
		state: {},
		cwd: runtime.services.cwd,
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		keyText: () => '',
		keyHint: () => ''
	} satisfies Parameters<typeof render>[2];
	const theme = runner.getUIContext().theme;
	const first = render(arguments_, theme, context);

	await updated.promise;

	const component = render(arguments_, theme, {
		...context,
		lastComponent: first
	});

	return component.render(120).join('\n');
}

it.each([
	{
		name: 'bash',
		input: { command: 'printf heading\u{202E}' },
		row: undefined
	},
	{ name: 'ls', input: { path: 'heading\u{202E}' }, row: 'entry\u{202E}' },
	{
		name: 'grep',
		input: { pattern: 'heading\u{202E}' },
		row: 'file.txt:1: entry\u{202E}'
	}
])(
	'cleans $name headings and rows without changing tool data',
	async ({ name, input, row }) => {
		await withPiRuntime([extension], (runtime, errors) => {
			const runner = runtime.session.extensionRunner;
			const tool = runner
				.getAllRegisteredTools()
				.find(({ definition }) => definition.name === name)?.definition;

			if (tool?.renderCall === undefined) {
				throw new Error('The tool call renderer was not registered.');
			}

			initTheme('dark', false);

			const theme = runner.getUIContext().theme;
			const context = {
				args: input,
				toolCallId: 'checked-display',
				invalidate() {
					return;
				},
				lastComponent: undefined,
				state: {},
				cwd: runtime.services.cwd,
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: true,
				showImages: false,
				isError: false,
				durationMs: undefined,
				outputPad: 0,
				keyText: () => '',
				keyHint: () => ''
			} satisfies Parameters<typeof tool.renderCall>[2];

			const heading = tool
				.renderCall(input, theme, context)
				.render(120)
				.join('\n');
			const content =
				row === undefined ? [] : [{ type: 'text' as const, text: row }];
			const result = tool
				.renderResult?.(
					{ content, details: undefined },
					{ expanded: true, isPartial: false },
					theme,
					context
				)
				.render(120)
				.join('\n');

			expect({
				errors,
				showsSafeHeading: heading.includes(String.raw`heading\u{202e}`),
				hasUnsafeHeading: heading.includes('\u{202E}'),
				showsSafeRow: result?.includes(String.raw`entry\u{202e}`) ?? false,
				hasUnsafeRow: result?.includes('\u{202E}') ?? false,
				content
			}).toStrictEqual({
				errors: [],
				showsSafeHeading: true,
				hasUnsafeHeading: false,
				showsSafeRow: row !== undefined,
				hasUnsafeRow: false,
				content: row === undefined ? [] : [{ type: 'text', text: row }]
			});

			return Promise.resolve();
		});
	}
);

it('does not render the contents of an excluded credential file', async () => {
	await withCredentialFixture(async (runtime, fixture) => {
		const text = await renderedEditPreview(runtime, {
			path: '~/.ssh/id_ed25519',
			edits: [{ oldText: 'replace me', newText: 'replacement' }]
		});

		expect({
			containsCredential: text.includes(fixture.marker),
			showsArguments: ['~/.ssh/id_ed25519', 'replace me', 'replacement'].every(
				(argument) => text.includes(argument)
			),
			unavailable: text.includes('Preview unavailable'),
			attempts: fixture.attempts
		}).toStrictEqual({
			containsCredential: false,
			showsArguments: true,
			unavailable: true,
			attempts: [{ operation: 'access', path: fixture.filename }]
		});
	});
});

it('renders display-safe preview text from the target without editing the file', async () => {
	const memory = new MemoryBackend();
	const target = 'target marker\u{202E}\nreplace me\n';

	memory.seed(filename, Buffer.from(target));

	await withPiRuntime(
		[fileProvider(memory), extension],
		async (runtime) => {
			const text = await renderedEditPreview(runtime, {
				path: filename,
				edits: [{ oldText: 'replace me', newText: 'replacement' }]
			});
			const content = memory.bytes(filename);

			expect({
				host: text.includes('host fixture'),
				target: text.includes('target marker' + String.raw`\u{202e}`),
				unescaped: text.includes('\u{202E}'),
				replacement: text.includes('replacement'),
				calls: memory.calls,
				content:
					content === undefined
						? undefined
						: Buffer.from(content).toString('utf8')
			}).toStrictEqual({
				host: false,
				target: true,
				unescaped: false,
				replacement: true,
				calls: [{ operation: 'readFile', path: '/remote/project/route.txt' }],
				content: target
			});
		},
		{
			prepare: (cwd) =>
				writeFile(path.join(cwd, filename), hostText + 'replace me\n')
		}
	);
});
