import { writeFileSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { expect, it, vi } from 'vitest';

import { ScriptedModel } from '../../../test-support/scripted-model.js';

import { createSandboxClient } from './client.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import type { FixtureProviderOptions } from './fixtures/register-provider.js';
import { registerFixtureProvider } from './fixtures/register-provider.js';
import { shellBackend } from './fixtures/shell-backend.js';
import { initialiseSandboxHost } from './host.js';
import sandboxTools from './pi-tools.js';
import type { Profile } from './policy-model.js';

const filename = 'read-fixture.json';

it.each([
	'missing',
	'existing',
	'embedded',
	'guarded',
	'concurrent-edit',
	'duplicate',
	'malformed',
	'project',
	'failure',
	'policy-changed',
	'read-write',
	'denied'
] as const)(
	'checks read approval duration with %s provider settings',
	async (scenario) => {
		const temporary = await mkdtemp(path.join(tmpdir(), 'byos-always-'));
		const directory = await realpath(temporary);
		const agentDirectory = path.join(directory, 'agent');
		const file = path.join(agentDirectory, filename);
		const guard = file + '.byos-read-roots.lock';
		const root = path.join(directory, 'approved');
		const auth = path.join(agentDirectory, 'auth.json');
		const relocatedAuth = path.join(directory, 'relocated-auth');
		const existing = path.join(directory, 'existing');
		const initialRoots =
			scenario === 'duplicate' ? [root, existing] : [existing];
		const wrote: (readonly string[])[] = [];
		const prompts: string[][] = [];
		const notices: string[] = [];
		const allocatedExclusions: (readonly string[] | undefined)[] = [];
		const { backend, requests } = shellBackend();
		const hostUserData =
			scenario === 'read-write' || scenario === 'denied'
				? scenario
				: 'read-only';
		const profile: Profile = {
			...backend.profile,
			policy: { ...backend.profile.policy, hostUserData },
			pathGrantKinds: ['read'] as const
		};
		const canPersist = hostUserData === 'read-only';
		const initial =
			scenario === 'missing'
				? undefined
				: {
						label: 'preserve',
						readRoots: initialRoots,
						...(!canPersist && { policy: profile.policy })
					};
		const concurrentEdit = JSON.stringify({
			label: 'another session',
			readRoots: [existing]
		});
		const changed = {
			...initial,
			policy: { ...profile.policy, hostUserData: 'read-write' }
		};
		const provider: InlineExtension = {
			name: 'persist-provider',
			factory(pi) {
				const registration: FixtureProviderOptions<Record<string, never>> = {
					async configure(context, shared) {
						expect(context.agentDirectory).toBe(agentDirectory);

						let contents = '{}';

						try {
							contents = await readFile(file, 'utf8');
						} catch (error) {
							if (
								!(error instanceof Error) ||
								!('code' in error) ||
								error.code !== 'ENOENT'
							) {
								throw error;
							}
						}

						const parsed: unknown = JSON.parse(contents);
						const schema = Type.Object(
							{ ...shared.properties, label: Type.Optional(Type.String()) },
							{ additionalProperties: false }
						);
						const validator = Compile(schema);

						if (!validator.Check(parsed)) {
							throw new Error('Invalid fixture settings.');
						}

						const { label: _label, ...settings } = parsed;

						return { configuration: {}, settings };
					},
					async persistReadRoot(context, shared) {
						wrote.push(context.paths);

						if (scenario === 'failure') {
							throw new Error('Fixture persistence failure.');
						}

						const schema = Type.Object(
							{ ...shared.properties, label: Type.Optional(Type.String()) },
							{ additionalProperties: false }
						);
						const validator = Compile(schema);

						let validations = 0;

						await context.updateSettings(filename, (value) => {
							if (scenario === 'concurrent-edit' && ++validations === 2) {
								writeFileSync(file, concurrentEdit);
							}

							return validator.Check(value);
						});
					}
				};

				registerFixtureProvider(
					pi,
					'<inline:persist-provider>',
					{
						id: 'fixture.persist',
						label: 'Persistent read fixture',
						profiles: { open: [profile], copy: [] },
						validateConfig: () => ({}),
						open(request) {
							allocatedExclusions.push(request.credentialExclusions);

							return Promise.resolve({
								...backend,
								profile: request.profile,
								workspace: {
									...backend.workspace,
									...(hostUserData !== 'denied' && {
										hostUserDataRoot: '/fixture/user-data'
									})
								},
								...(request.hostUserDataRoots !== undefined && {
									hostUserDataRoots: request.hostUserDataRoots
								}),
								grantedPaths: (request.paths?.read ?? []).map((hostPath) => ({
									kind: 'read' as const,
									hostPath,
									targetPath: hostPath
								}))
							});
						}
					},
					registration
				);
			}
		};
		const host: InlineExtension = {
			name: 'persist-host',
			factory(pi) {
				initialiseSandboxHost(pi, '<inline:persist-host>', { agentDirectory });
			}
		};
		const hosts = scenario === 'embedded' ? [host] : [];
		const commands = 'read configured document';
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: 'persist-read',
				name: 'bash',
				arguments: {
					command: commands,
					escalate: [{ read: [root] }],
					justification: 'Read the fixture.'
				}
			}
		]);
		let projectFile: string | undefined;

		try {
			await mkdir(agentDirectory);
			await mkdir(root);
			await symlink(relocatedAuth, auth);
			vi.stubEnv(
				'PI_CODING_AGENT_DIR',
				scenario === 'embedded'
					? path.join(directory, 'default-agent')
					: agentDirectory
			);

			if (initial !== undefined) {
				await writeFile(file, JSON.stringify(initial));
			}

			await withPiRuntime(
				[
					...hosts,
					provider,
					{
						name: 'persist-tools',
						factory(pi) {
							sandboxTools(pi, '<inline:persist-tools>');
						}
					},
					model.extension
				],
				async (runtime, errors) => {
					const chosen = runtime.session.modelRuntime.getModel(
						'scripted',
						'scripted'
					);

					if (chosen === undefined) {
						throw new Error('The scripted model was not registered.');
					}

					await runtime.session.setModel(chosen);
					runtime.session.setActiveToolsByName(['bash']);
					await runtime.session.prompt('Approve the read.');
					expect(errors).toStrictEqual([]);

					if (scenario === 'project' && projectFile !== undefined) {
						expect(await readFile(projectFile, 'utf8')).toBe(
							JSON.stringify(initial)
						);
					}
				},
				{
					prepare(checkout) {
						projectFile = path.join(checkout, filename);
					},
					async select(_text, choices) {
						prompts.push([...choices]);

						switch (scenario) {
							case 'guarded': {
								await writeFile(guard, 'other session');
								break;
							}

							case 'malformed': {
								await writeFile(file, '{');
								break;
							}

							case 'policy-changed': {
								await writeFile(file, JSON.stringify(changed));
								break;
							}

							default: {
								break;
							}
						}

						if (scenario === 'project' && projectFile !== undefined) {
							await writeFile(projectFile, JSON.stringify(initial));
							await rm(file);
							await symlink(projectFile, file);
						}

						return choices.find(
							(choice) => choice === (canPersist ? 'Allow always' : 'Allow')
						);
					},
					notify(message) {
						notices.push(message);
					}
				}
			);

			if (scenario === 'guarded' || scenario === 'concurrent-edit') {
				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map((message) => ({
						isError: message.isError,
						content: message.content
					}));
				const message: unknown = expect.stringContaining(
					scenario === 'guarded' ? guard : 'The provider settings changed'
				);
				const contents = await readFile(file, 'utf8');

				expect({ results, contents }).toStrictEqual({
					results: [
						{ isError: true, content: [{ type: 'text', text: message }] }
					],
					contents:
						scenario === 'guarded' ? JSON.stringify(initial) : concurrentEdit
				});

				if (scenario === 'guarded') {
					expect(await readFile(guard, 'utf8')).toBe('other session');
				} else {
					await expect(readFile(guard, 'utf8')).rejects.toMatchObject({
						code: 'ENOENT'
					});
				}
			} else if (scenario === 'embedded' || scenario === 'denied') {
				expect(
					allocatedExclusions.map((paths) =>
						paths?.filter((entry) => entry.startsWith(directory + path.sep))
					)
				).toStrictEqual([
					[auth, path.join(agentDirectory, 'mcp-auth.json'), relocatedAuth]
				]);
			}

			const isSucceeded =
				scenario === 'missing' ||
				scenario === 'existing' ||
				scenario === 'embedded' ||
				scenario === 'duplicate';

			expect({
				wrote,
				prompts,
				notices: notices.map((message) => [
					message.includes(root),
					message.includes(file)
				]),
				commands: requests.map((request) =>
					request.kind === 'shell' ? request.command : undefined
				)
			}).toStrictEqual({
				wrote: canPersist ? [[root]] : [],
				prompts: [
					[
						'Deny',
						'Allow',
						'Allow for session',
						...(canPersist ? ['Allow always'] : [])
					]
				],
				notices: isSucceeded ? [[true, true]] : [],
				commands: isSucceeded || !canPersist ? [commands] : []
			});

			if (!isSucceeded) {
				if (scenario !== 'project' && scenario !== 'concurrent-edit') {
					const expected = {
						malformed: '{',
						'policy-changed': JSON.stringify(changed)
					};
					const contents =
						scenario === 'malformed' || scenario === 'policy-changed'
							? expected[scenario]
							: JSON.stringify(initial);

					expect(await readFile(file, 'utf8')).toBe(contents);
				}

				return;
			}

			const expected = {
				...(initial !== undefined && { label: initial.label }),
				readRoots:
					scenario === 'missing'
						? [root]
						: [...new Set([...initialRoots, root])]
			};
			const saved: unknown = JSON.parse(await readFile(file, 'utf8'));

			expect(saved).toStrictEqual(expected);

			const reloaded: unknown[] = [];

			await withPiRuntime(
				[
					...hosts,
					provider,
					{
						name: 'persist-consumer',
						factory(pi) {
							const client = createSandboxClient(
								pi,
								'<inline:persist-consumer>'
							);

							pi.on('session_start', async (_event, context) => {
								reloaded.push(
									await client.negotiate(context, {
										access: { paths: { read: [root] } }
									})
								);
							});
						}
					}
				],
				(_runtime, errors) => {
					expect({ reloaded, errors }).toStrictEqual({
						reloaded: [{ ok: true, profile }],
						errors: []
					});

					return Promise.resolve();
				}
			);
		} finally {
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	}
);
