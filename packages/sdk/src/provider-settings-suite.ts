import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect } from 'vitest';

import { builtinProviders } from './builtin-providers.js';
import { createSandboxClient } from './client.js';
import type { SandboxContext, SandboxSharedSettings } from './contracts.js';
import { discoverBroker } from './discovery.js';
import { defaultPolicy } from './policy-model.js';
import { isWithinLimit } from './profile-negotiation.js';
import type {
	SandboxProviderTestFixture,
	SandboxProviderTestOptions
} from './provider-test-contracts.js';
import { bounded } from './provider-test-harness.js';

export const invalidSharedSettings = [
	{ field: 'policy', settings: { policy: 'invalid' } },
	{ field: 'allowEscalation', settings: { allowEscalation: 'invalid' } },
	{ field: 'userShell', settings: { userShell: 'invalid' } },
	{ field: 'cleanup', settings: { cleanup: { disposalTimeoutMs: 0 } } },
	{ field: 'readRoots', settings: { readRoots: [''] } }
] as const;

const extensionSource = '<inline:provider-conformance-settings>';

type SettingsCase =
	'valid' | 'default' | 'preset' | (typeof invalidSharedSettings)[number];

async function withRegisteredFixture<Config>(
	fixture: SandboxProviderTestFixture<Config>,
	agentDirectory: string,
	verify: (pi: ExtensionAPI, context: SandboxContext) => Promise<void>
): Promise<void> {
	const { register } = fixture;

	if (register === undefined) {
		throw new Error(
			'Provide the fixture register callback for registration conformance.'
		);
	}

	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDirectory, 'auth.json'),
		modelsPath: path.join(agentDirectory, 'models.json'),
		modelsStorePath: path.join(agentDirectory, 'model-store.json'),
		allowModelNetwork: false,
		refreshOnCreate: false
	});
	const vertex = modelRuntime.getProvider('google-vertex');

	if (vertex !== undefined) {
		modelRuntime.registerNativeProvider({
			...vertex,
			auth: {
				apiKey: {
					name: 'Fixture auth',
					resolve: () => Promise.resolve(undefined)
				}
			}
		});
	}

	const observation: { pi?: ExtensionAPI; context?: SandboxContext } = {};
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noThemes: true,
					noPromptTemplates: true,
					noContextFiles: true,
					extensionFactories: [
						{
							name: 'provider-conformance-settings',
							async factory(pi) {
								await register(pi, extensionSource);
								createSandboxClient(pi, extensionSource);
								observation.pi = pi;
								pi.on('session_start', (_event, context) => {
									observation.context = context;
								});
							}
						}
					]
				}
			});
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				noTools: 'all',
				...(sessionStartEvent !== undefined && { sessionStartEvent })
			});

			return { ...result, services, diagnostics: services.diagnostics };
		},
		{
			cwd: fixture.hostWorkspace,
			agentDir: agentDirectory,
			sessionManager: SessionManager.inMemory(fixture.hostWorkspace)
		}
	);
	const errors: unknown[] = [];
	const bind = (session: typeof runtime.session) =>
		session.bindExtensions({
			onError: (error) => {
				errors.push(error);
			}
		});

	runtime.setRebindSession(bind);

	try {
		await bind(runtime.session);
		expect(errors).toStrictEqual([]);

		const { pi, context } = observation;

		if (pi === undefined || context === undefined) {
			throw new Error('Pi did not start the provider registration fixture.');
		}

		await verify(pi, context);
	} finally {
		await runtime.dispose();
	}
}

export async function verifyFixtureSettings<Config>(
	options: SandboxProviderTestOptions<Config>,
	scenario: SettingsCase
): Promise<void> {
	const fixture = await options.createFixture();
	const agentDirectory = await mkdtemp(
		path.join(tmpdir(), 'byos-settings-suite-')
	);

	try {
		const provider = fixture.provider ?? options.provider;
		const supplied: SandboxSharedSettings =
			scenario === 'valid'
				? {
						policy: fixture.policy,
						userShell: provider.profiles.open[0]?.shells[0] ?? 'sh',
						allowEscalation: false,
						cleanup: { cancellationGraceMs: 4000, disposalTimeoutMs: 8000 },
						readRoots: [agentDirectory]
					}
				: {};

		if (scenario !== 'preset') {
			if (fixture.stageSettings === undefined) {
				throw new Error(
					'Provide the fixture stageSettings callback for a settings reader.'
				);
			}

			await fixture.stageSettings(
				typeof scenario === 'string' ? supplied : scenario.settings
			);
		}

		await withRegisteredFixture(
			fixture,
			agentDirectory,
			async (pi, context) => {
				const broker = discoverBroker(pi.events);

				if (broker === undefined) {
					throw new Error(
						'Pi did not elect a broker for the provider settings fixture.'
					);
				}

				const declarations = await broker.providers(context);

				expect(
					declarations.filter(({ id }) => !builtinProviders.has(id))
				).toMatchObject([{ id: provider.id, profiles: provider.profiles }]);

				if (typeof scenario !== 'string') {
					const field: unknown = expect.stringContaining(scenario.field);

					await expect(broker.acquire(context)).rejects.toMatchObject({
						name: 'InvalidSandboxConfigError',
						detail: { kind: 'config', field }
					});

					const status = await broker.status(context);

					expect(status.backends ?? []).toStrictEqual([]);
					await bounded(options, () => fixture.verifyDisposed());

					return;
				}

				const result = await broker.negotiate(context);
				const { selection, backends } = await broker.status(context);

				expect(backends ?? []).toStrictEqual([]);

				if (scenario === 'default') {
					if (
						provider.profiles.open.every(
							({ policy }) => !isWithinLimit(policy, defaultPolicy)
						)
					) {
						expect(result).toMatchObject({
							ok: false,
							error: {
								name: 'UnsupportedSandboxPolicyError',
								detail: { kind: 'policy', reason: 'profile' }
							}
						});

						return;
					}

					expect({
						selection,
						isWithinDefaults:
							result.ok && isWithinLimit(result.profile.policy, defaultPolicy)
					}).toStrictEqual({
						selection: {
							providerId: provider.id,
							source: 'extension',
							policy: result.ok ? result.profile.policy : undefined
						},
						isWithinDefaults: true
					});

					return;
				}

				expect({
					selection,
					policy: result.ok ? result.profile.policy : undefined
				}).toStrictEqual({
					selection: {
						providerId: provider.id,
						source: 'extension',
						policy: fixture.policy,
						...(supplied.userShell !== undefined && {
							userShell: supplied.userShell
						})
					},
					policy: fixture.policy
				});
			}
		);
	} finally {
		try {
			await bounded(options, () => fixture.cleanup());
		} finally {
			await rm(agentDirectory, { recursive: true, force: true });
		}
	}
}
