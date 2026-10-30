import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	InMemoryCredentialStore,
	InMemoryModelsStore
} from '@earendil-works/pi-ai';
import type {
	AgentSessionRuntime,
	CreateAgentSessionRuntimeFactory,
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

interface RuntimeOptions {
	readonly prepare?: (
		directory: string,
		agentDirectory: string
	) => void | Promise<void>;
	readonly includeBuiltins?: boolean;
}

export async function withPiRuntime(
	extensions: readonly InlineExtension[],
	execute: (
		runtime: AgentSessionRuntime,
		errors: readonly unknown[]
	) => Promise<void>,
	fixtureOptions?: RuntimeOptions
): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-runtime-'));
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
				settingsManager: SettingsManager.inMemory(),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noThemes: true,
					noPromptTemplates: true,
					noContextFiles: true,
					extensionFactories: [...extensions]
				}
			});
			const result = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				...(fixtureOptions?.includeBuiltins !== true && { noTools: 'builtin' }),
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
		runtime.setRebindSession((session) =>
			session.bindExtensions({
				onError: (error) => {
					errors.push(error);
				}
			})
		);
		try {
			await runtime.session.bindExtensions({
				onError: (error) => {
					errors.push(error);
				}
			});
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
