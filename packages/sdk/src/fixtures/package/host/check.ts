import assert from 'node:assert/strict';
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	InMemoryCredentialStore,
	InMemoryModelsStore
} from '@earendil-works/pi-ai';
import type {
	CreateAgentSessionRuntimeFactory,
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import type {
	ProcessResult,
	SandboxClient,
	SandboxContext,
	SandboxHost
} from 'pi-bring-your-own-sandbox/api';
import * as sdk from 'pi-bring-your-own-sandbox/api';

import * as peer from '../provider/provider.js';

interface Consumer {
	readonly inspectWorkspace: (
		client: SandboxClient,
		pi: SandboxHost,
		context: SandboxContext,
		signal?: AbortSignal
	) => Promise<ProcessResult>;
}

function isConsumer(value: unknown): value is Consumer {
	return (
		typeof value === 'object' &&
		value !== null &&
		'inspectWorkspace' in value &&
		typeof value.inspectWorkspace === 'function'
	);
}

const root = process.cwd();
const apiUrl = import.meta.resolve('pi-bring-your-own-sandbox/api');
const sdkRoot = path.dirname(path.dirname(fileURLToPath(apiUrl)));

assert.notEqual(
	await realpath(fileURLToPath(apiUrl)),
	await realpath(fileURLToPath(peer.apiUrl))
);
assert.notEqual(sdk.SandboxOperationError, peer.sdk.SandboxOperationError);
assert.equal(
	sdk.isSandboxError(
		new peer.sdk.SandboxOperationError({ operation: 'exec' }),
		sdk.SandboxOperationError
	),
	true
);

const testRunner = 'vitest';

await assert.rejects(import(testRunner), { code: 'ERR_MODULE_NOT_FOUND' });
await assert.rejects(import('pi-bring-your-own-sandbox/testing'), {
	code: 'ERR_MODULE_NOT_FOUND'
});

const workspace = path.join(root, 'workspace');
const agentDirectory = path.join(root, 'agent');

await mkdir(workspace);
await mkdir(agentDirectory);
process.env.PI_CODING_AGENT_DIR = agentDirectory;
await writeFile(
	path.join(agentDirectory, 'byos.json'),
	JSON.stringify({
		provider: 'packed.fixture',
		approval: { policy: 'packed.review' },
		outsideSandbox: { destination: 'provider' },
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default'
		}
	})
);

const consumer = path.join(sdkRoot, 'examples/consumer/src');
const docker = path.join(sdkRoot, 'examples/docker/src');

const helperPath = path.join(root, 'workspace-helper.ts');

await copyFile(path.join(consumer, 'workspace.ts'), helperPath);

const helper: unknown = await import(pathToFileURL(helperPath).href);

assert.ok(isConsumer(helper));

const modelRuntime = await ModelRuntime.create({
	credentials: new InMemoryCredentialStore(),
	modelsStore: new InMemoryModelsStore(),
	modelsPath: path.join(agentDirectory, 'models.json'),
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

const live: { pi?: ExtensionAPI; context?: ExtensionContext } = {};
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
			additionalExtensionPaths: [
				sdkRoot,
				path.join(sdkRoot, 'dist/pi-tools.js'),
				path.join(consumer, 'index.ts'),
				path.join(docker, 'index.ts')
			],
			extensionFactories: [
				{ name: 'peer-provider', factory: peer.default },
				{
					name: 'capture',
					factory(pi) {
						live.pi = pi;
						pi.on('session_start', (_event, context) => {
							live.context = context;
						});
					}
				}
			]
		}
	});
	const loaded = services.resourceLoader.getExtensions();

	assert.deepEqual(
		{
			errors: loaded.errors,
			tools: loaded.extensions.flatMap((extension) =>
				extension.tools.keys().toArray()
			),
			commands: loaded.extensions.flatMap((extension) =>
				extension.commands.keys().toArray()
			)
		},
		{
			errors: [],
			tools: ['bash', 'powershell', 'sandbox_pwd'],
			commands: ['byos']
		}
	);

	const result = await createAgentSessionFromServices({
		services,
		sessionManager: options.sessionManager,
		noTools: 'builtin'
	});

	return { ...result, services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(create, {
	cwd: workspace,
	agentDir: agentDirectory,
	sessionManager: SessionManager.inMemory(workspace)
});

try {
	await runtime.session.bindExtensions({
		onError(error) {
			errors.push(error);
		}
	});
	assert.deepEqual(errors, []);
	assert.ok(live.pi);
	assert.ok(live.context);

	const [first, second] = await Promise.all([
		sdk.getSandbox(live.pi, live.context),
		peer.sdk.getSandbox(live.pi, live.context)
	]);

	assert.deepEqual(
		{ generationId: first.generationId, backendId: first.backendId },
		{ generationId: second.generationId, backendId: second.backendId }
	);

	const results = [];

	for (const client of [sdk, peer.sdk]) {
		const result = await helper.inspectWorkspace(
			client,
			live.pi,
			live.context,
			new AbortController().signal
		);

		results.push({
			exit: result.exit,
			stdout: new TextDecoder().decode(result.stdout),
			stderr: new TextDecoder().decode(result.stderr),
			omittedBytes: result.omittedBytes
		});
	}

	assert.deepEqual(
		results,
		[0, 1].map(() => ({
			exit: { kind: 'code', code: 0 },
			stdout: '/packed/project\n',
			stderr: '',
			omittedBytes: { stdout: 0, stderr: 0 }
		}))
	);

	for (const client of [sdk, peer.sdk]) {
		const outside = await client.getOutsideSandboxExecutor(
			live.pi,
			live.context
		);
		const result = await outside.exec(
			{ kind: 'argv', executable: 'pwd', args: [] },
			{
				justification: 'Check the packed outside destination.'
			}
		);

		assert.deepEqual(
			{
				kind: outside.destination.kind,
				exit: result.exit,
				stdout: new TextDecoder().decode(result.stdout)
			},
			{
				kind: 'provider',
				exit: { kind: 'code', code: 0 },
				stdout: '/packed/project\n'
			}
		);
	}

	assert.equal(sdk.isApprovalError(new peer.sdk.ApprovalDeniedError()), true);

	assert.deepEqual(await sdk.closeSandboxSession(live.pi, live.context), {
		confirmed: true,
		failures: [],
		recoveries: []
	});
	assert.deepEqual(peer.state, {
		opens: 2,
		reviews: 2,
		disposals: 2,
		isRunning: false,
		calls: [0, 1, 2, 3].map(() => ({
			kind: 'argv',
			executable: 'pwd',
			args: []
		}))
	});
} finally {
	await runtime.dispose();
}
