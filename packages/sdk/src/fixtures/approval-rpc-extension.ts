import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import {
	closeSandboxSession,
	getOutsideSandboxExecutor,
	isApprovalError,
	isSandboxError,
	registerApprovalPolicy,
	registerSandboxProvider
} from '../api.js';
import type { SandboxBackend } from '../contracts.js';
import sandboxExtension from '../extension.js';
import sandboxTools from '../pi-tools.js';
import { checker } from '../schemas.js';

import { ScriptedModel } from './scripted-model.js';

const modelArgumentsSchema = Type.Record(
	Type.String(),
	Type.Union([Type.String(), Type.Number()])
);
const fixtureConfigSchema = Type.Object({
	mode: Type.Enum(['sdk', 'bash', 'powershell']),
	timeoutMs: Type.Number({ exclusiveMinimum: 0 }),
	failure: Type.Optional(Type.Enum(['open', 'exec'])),
	arguments: Type.Optional(modelArgumentsSchema)
});
const isConfig = checker(fixtureConfigSchema);

export default async function approvalRpcFixture(
	pi: ExtensionAPI
): Promise<void> {
	const contents = await readFile(
		path.join(process.cwd(), 'fixture.json'),
		'utf8'
	);
	const input: unknown = JSON.parse(contents);

	if (!isConfig(input)) {
		throw new Error('Invalid approval RPC fixture configuration.');
	}

	const config = input;
	const journal = (record: unknown) =>
		appendFile(
			path.join(process.cwd(), 'journal.jsonl'),
			`${JSON.stringify(record)}\n`
		);
	const policy = {
		workspaceAccess: 'read-write',
		filesystemScope: 'provider-default',
		networkAccess: 'provider-default'
	} as const;
	const capabilities = {
		processKinds: ['argv', 'shell'],
		terminationScope: 'workload',
		exitStatus: 'guaranteed',
		operations: ['exec'],
		shells: ['bash', 'powershell']
	} as const;
	const backend: SandboxBackend = {
		id: 'rpc-outside',
		capabilities,
		policy,
		workspace: {
			root: '/rpc/target',
			pathFlavor: 'posix',
			relationship: 'remote',
			description: 'RPC fixture workspace.'
		},
		policyDescription: 'Outside execution in a fake remote environment.',
		recovery: { kind: 'none' },
		async exec(request, context) {
			await journal({ kind: 'execute', request });

			if (config.failure === 'exec') {
				throw new Error('Synthetic execution failure.');
			}

			await appendFile(path.join(process.cwd(), 'executions'), 'provider\n');
			context.onOutput({
				stream: 'stdout',
				data: new TextEncoder().encode('approved')
			});

			return { kind: 'exited', exit: { kind: 'code', code: 0 } };
		},
		dispose: () => journal({ kind: 'dispose' })
	};

	registerSandboxProvider(pi, {
		id: 'rpc-provider',
		label: 'RPC sandbox',
		protocolVersion: 1,
		capabilities,
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		validateConfig: () => ({}),
		async open() {
			await journal({ kind: 'ordinary-open' });

			return backend;
		},
		outsideSandbox: {
			label: 'RPC outside destination',
			capabilities,
			policy,
			async open() {
				await journal({ kind: 'outside-open' });

				if (config.failure === 'open') {
					throw new Error('Synthetic allocation failure.');
				}

				return backend;
			}
		}
	});

	registerApprovalPolicy(pi, {
		id: 'rpc-failure',
		label: 'Failing reviewer',
		protocolVersion: 1,
		validateConfig: () => ({}),
		decide: () => Promise.reject(new Error('Synthetic policy failure.'))
	});

	let pending: Promise<void> | undefined;
	let hasShutdownObserver = false;
	let controller = new AbortController();

	pi.registerCommand('fixture-sdk', {
		description: 'Execute through the SDK and real RPC confirmation UI.',
		async handler(arguments_, context) {
			controller = new AbortController();
			pending = (async () => {
				try {
					const executor = await getOutsideSandboxExecutor(pi, context);
					const running = executor.exec(
						{
							kind: 'argv',
							executable: process.execPath,
							args: [
								'-e',
								'require("node:fs").appendFileSync("executions", "normal\\n"); process.stdout.write("approved")'
							],
							cwd: executor.destination.workspace.root,
							env: { VISIBLE_OVERRIDE: 'synthetic-secret' }
						},
						{
							justification: 'Exercise user approval through RPC.',
							signal: controller.signal,
							timeoutMs: arguments_ === 'short' ? 100 : config.timeoutMs
						}
					);

					if (!hasShutdownObserver) {
						hasShutdownObserver = true;
						pi.on('session_shutdown', async () => {
							await pending;
							await journal({ kind: 'shutdown' });
						});
					}

					const result = await running;

					await journal({
						kind: 'result',
						exit: result.exit,
						stdout: new TextDecoder().decode(result.stdout)
					});
				} catch (error) {
					if (!isSandboxError(error) && !isApprovalError(error)) {
						throw error;
					}

					await journal({
						kind: 'error',
						name: error.name,
						...('reason' in error && { reason: error.reason }),
						...('completion' in error && { completion: error.completion })
					});
				}
			})();

			await pending;
		}
	});
	pi.registerCommand('fixture-cancel', {
		description: 'Cancel a pending SDK invocation.',
		handler() {
			controller.abort();

			return Promise.resolve();
		}
	});
	pi.registerCommand('fixture-close', {
		description: 'Close the SDK while an approval is pending.',
		async handler(_arguments, context) {
			await closeSandboxSession(pi, context);
		}
	});

	sandboxTools(pi);
	sandboxExtension(pi);

	if (config.mode === 'sdk') {
		return;
	}

	pi.on('session_start', () => {
		pi.setActiveTools([config.mode]);
	});

	const model = new ScriptedModel([
		{
			type: 'toolCall',
			id: 'outside',
			name: config.mode,
			arguments: config.arguments ?? {
				command: "printf 'normal\\n' >> executions; printf approved",
				execution: 'outside-sandbox',
				justification: 'Exercise user approval through RPC.',
				timeout: config.timeoutMs / 1000
			}
		}
	]);

	const extension = model.extension;

	await (typeof extension === 'function' ? extension : extension.factory)(pi);
}
