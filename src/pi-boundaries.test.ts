import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	createEditTool,
	createEditToolDefinition,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	initTheme,
	VERSION
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { withPiRuntime } from './fixtures/pi-runtime.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

async function workspace(run: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-boundary-'));

	try {
		await run(directory);
	} catch (error) {
		throw new Error(`Pi ${VERSION} on Node ${process.version}`, {
			cause: error
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

it('resolves a custom read using host filename variants', async () => {
	await workspace(async (directory) => {
		const requested = "Capture d'ecran.txt";
		const variant = 'Capture d’ecran.txt';
		const calls: string[] = [];
		const tool = createReadTool(directory, {
			operations: {
				access(filename) {
					calls.push(filename);

					return Promise.resolve();
				},
				readFile: (filename) =>
					Promise.resolve(
						Buffer.from(
							path.basename(filename) === requested
								? 'target requested file'
								: 'target variant file'
						)
					)
			}
		});
		const before = await tool.execute('before', { path: requested });

		await writeFile(path.join(directory, variant), 'host sentinel');

		const after = await tool.execute('after', { path: requested });

		expect({
			calls,
			before: before.content,
			after: after.content
		}).toStrictEqual({
			calls: [path.join(directory, requested), path.join(directory, variant)],
			before: [{ type: 'text', text: 'target requested file' }],
			after: [{ type: 'text', text: 'target variant file' }]
		});
	});
});

it.each(['write', 'edit'] as const)(
	'checks host realpath before custom %s operations',
	async (operation) => {
		await workspace(async (directory) => {
			const filename = path.join(directory, 'cycle');

			await symlink('cycle', filename);

			const calls: string[] = [];
			const invocation =
				operation === 'write'
					? createWriteTool(directory, {
							operations: {
								mkdir(target) {
									calls.push(target);

									return Promise.resolve();
								},
								writeFile(target) {
									calls.push(target);

									return Promise.resolve();
								}
							}
						}).execute('mutation', { path: 'cycle', content: 'target new' })
					: createEditTool(directory, {
							operations: {
								access(target) {
									calls.push(target);

									return Promise.resolve();
								},
								readFile(target) {
									calls.push(target);

									return Promise.resolve(Buffer.from('target old'));
								},
								writeFile(target) {
									calls.push(target);

									return Promise.resolve();
								}
							}
						}).execute('mutation', {
							path: 'cycle',
							edits: [{ oldText: 'target old', newText: 'target new' }]
						});

			await expect(invocation).rejects.toMatchObject({ code: 'ELOOP' });
			expect(calls).toStrictEqual([]);
		});
	}
);

it.each(['find', 'ls'] as const)(
	'uses host path semantics before custom %s operations',
	async (operation) => {
		await workspace(async (directory) => {
			const target =
				path.sep === '/' ? String.raw`C:\remote\project` : '/remote/project';
			const calls: string[] = [];
			const invocation =
				operation === 'find'
					? createFindTool(directory, {
							operations: {
								exists: () => true,
								glob(_pattern, root) {
									calls.push(root);

									return [];
								}
							}
						}).execute('search', { path: target, pattern: '*' })
					: createLsTool(directory, {
							operations: {
								exists: () => true,
								stat: () => ({ isDirectory: () => true }),
								readdir(root) {
									calls.push(root);

									return [];
								}
							}
						}).execute('search', { path: target });

			await invocation;
			expect({ calls, hasTargetRoot: calls.includes(target) }).toStrictEqual({
				calls: [path.resolve(directory, target)],
				hasTargetRoot: false
			});
		});
	}
);

it('searches host content despite custom grep operations', async () => {
	await promisify(execFile)('rg', ['--version']);
	await workspace(async (directory) => {
		await writeFile(path.join(directory, 'sentinel.txt'), 'host-only-needle\n');

		const calls: string[] = [];
		const tool = createGrepTool(directory, {
			operations: {
				isDirectory(root) {
					calls.push(root);

					return true;
				},
				readFile: () => 'target-only-needle\n'
			}
		});
		const host = await tool.execute('host', { pattern: 'host-only-needle' });
		const target = await tool.execute('target', {
			pattern: 'target-only-needle'
		});

		expect({ calls, host: host.content, target: target.content }).toStrictEqual(
			{
				calls: [directory, directory],
				host: [{ type: 'text', text: 'sentinel.txt:1: host-only-needle' }],
				target: [{ type: 'text', text: 'No matches found' }]
			}
		);
	});
});

it('reads host content for an edit preview before execution', async () => {
	await withPiRuntime(
		[
			{
				name: 'preview-theme',
				factory(pi) {
					pi.on('session_start', () => {
						initTheme('dark');
					});
				}
			}
		],
		async (runtime) => {
			const directory = runtime.services.cwd;

			await writeFile(
				path.join(directory, 'preview.txt'),
				'host sentinel\nold\n'
			);

			const calls: string[] = [];
			const tool = createEditToolDefinition(directory, {
				operations: {
					access(filename) {
						calls.push(filename);

						return Promise.resolve();
					},
					readFile(filename) {
						calls.push(filename);

						return Promise.resolve(Buffer.from('target sentinel\nold\n'));
					},
					writeFile(filename) {
						calls.push(filename);

						return Promise.resolve();
					}
				}
			});
			const render = tool.renderCall;

			expect(render).toBeTypeOf('function');

			if (render === undefined) {
				throw new Error('Pi did not expose the edit call renderer.');
			}

			const updated = Promise.withResolvers<undefined>();
			const context = {
				args: {
					path: 'preview.txt',
					edits: [{ oldText: 'old', newText: 'new' }]
				},
				toolCallId: 'preview',
				invalidate: () => {
					updated.resolve(undefined);
				},
				lastComponent: undefined,
				state: {},
				cwd: directory,
				executionStarted: false,
				argsComplete: true,
				isPartial: false,
				expanded: true,
				showImages: false,
				isError: false,
				durationMs: undefined,
				outputPad: 0
			};
			const theme = runtime.session.extensionRunner.getUIContext().theme;
			const component = render(context.args, theme, context);

			await updated.promise;

			const text = render(context.args, theme, {
				...context,
				lastComponent: component
			})
				.render(120)
				.join('\n');

			expect({
				calls,
				hasHost: text.includes('host sentinel'),
				hasTarget: text.includes('target sentinel'),
				executionStarted: context.executionStarted
			}).toStrictEqual({
				calls: [],
				hasHost: true,
				hasTarget: false,
				executionStarted: false
			});
		},
		{
			prepare(_directory, agentDirectory) {
				vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
			}
		}
	);
});
