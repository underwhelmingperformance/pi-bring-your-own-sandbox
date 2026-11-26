import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	InMemoryCredentialStore,
	InMemoryModelsStore
} from '@earendil-works/pi-ai';
import type {
	AgentSession,
	AgentSessionRuntime,
	CreateAgentSessionRuntimeFactory,
	ExtensionUIContext,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	VERSION
} from '@earendil-works/pi-coding-agent';

import { bindFactory } from '../default-broker.js';
import { hasProtocolAddress } from '../protocol-address.js';

interface RuntimeOptions {
	readonly temporaryDirectory?: string;
	readonly prepare?: (
		directory: string,
		agentDirectory: string
	) => void | Promise<void>;
	readonly includeBuiltins?: boolean;
	readonly projectTrusted?: boolean;
	readonly notify?: ExtensionUIContext['notify'];
	readonly tools?: readonly string[];
	readonly bindFixtureSources?: boolean;
	readonly additionalExtensionPaths?: readonly string[];
}

export async function withPiRuntime(
	extensions: readonly InlineExtension[],
	execute: (
		runtime: AgentSessionRuntime,
		errors: readonly unknown[]
	) => Promise<void>,
	fixtureOptions?: RuntimeOptions
): Promise<void> {
	const directory = await mkdtemp(
		path.join(
			fixtureOptions?.temporaryDirectory ?? tmpdir(),
			'pi-byos-runtime-'
		)
	);
	const agentDirectory = path.join(directory, 'agent');

	await mkdir(agentDirectory);

	try {
		await fixtureOptions?.prepare?.(directory, agentDirectory);

		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: path.join(agentDirectory, 'models.json'),
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false
		});
		// Provider registration refreshes Vertex auth even with model network access disabled.
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

		const errors: unknown[] = [];

		const create: CreateAgentSessionRuntimeFactory = async (options) => {
			const services = await createAgentSessionServices({
				cwd: options.cwd,
				agentDir: options.agentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory(
					{},
					{
						...(fixtureOptions?.projectTrusted !== undefined && {
							projectTrusted: fixtureOptions.projectTrusted
						})
					}
				),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noThemes: true,
					noPromptTemplates: true,
					noContextFiles: true,
					...(fixtureOptions?.additionalExtensionPaths !== undefined && {
						additionalExtensionPaths: [
							...fixtureOptions.additionalExtensionPaths
						]
					}),
					extensionFactories: extensions.map((extension) => {
						if (fixtureOptions?.bindFixtureSources === false) {
							return extension;
						}

						const item =
							typeof extension === 'function'
								? { name: extension.name || 'fixture', factory: extension }
								: extension;

						return {
							...item,
							async factory(pi) {
								await item.factory(pi);

								if (!hasProtocolAddress(pi.events)) {
									bindFactory(pi, `<inline:${item.name}>`);
								}
							}
						};
					})
				}
			});
			const result = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				...(fixtureOptions?.includeBuiltins !== true && { noTools: 'builtin' }),
				...(fixtureOptions?.tools !== undefined && {
					tools: [...fixtureOptions.tools]
				}),
				...(options.sessionStartEvent !== undefined && {
					sessionStartEvent: options.sessionStartEvent
				})
			});

			return { ...result, services, diagnostics: services.diagnostics };
		};

		const runtime = await createAgentSessionRuntime(create, {
			cwd: directory,
			agentDir: agentDirectory,
			sessionManager: SessionManager.inMemory(directory)
		});

		const bind = (session: AgentSession) =>
			session.bindExtensions({
				...(fixtureOptions?.notify !== undefined && {
					mode: 'tui',
					uiContext: {
						...session.extensionRunner.getUIContext(),
						notify: fixtureOptions.notify
					}
				}),
				onError: (error) => {
					errors.push(error);
				}
			});

		runtime.setRebindSession(bind);

		try {
			await bind(runtime.session);
			await execute(runtime, errors);
		} finally {
			await runtime.dispose();
		}
	} catch (error) {
		throw new Error(`Pi ${VERSION} on Node ${process.version}`, {
			cause: error
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
