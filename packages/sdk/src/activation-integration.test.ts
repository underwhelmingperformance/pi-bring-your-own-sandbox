import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	createEventBus,
	SessionManager
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import {
	closeSandboxSession,
	getSandbox,
	registerSandboxProvider
} from './api.js';
import type {
	SandboxConfigContext,
	SandboxHost,
	SandboxProvider
} from './contracts.js';
import { formatStatus } from './diagnostics.js';
import { discoverBroker } from './discovery.js';
import { connectionProvider } from './fixtures/connection-provider.js';
import { MemoryBackend } from './fixtures/memory-backend.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

async function fixture(
	run: (
		pi: SandboxHost,
		context: { cwd: string; sessionManager: SessionManager }
	) => Promise<void>
) {
	const directory = await mkdtemp(path.join(tmpdir(), 'byos-activation-'));

	vi.stubEnv('PI_CODING_AGENT_DIR', directory);

	const pi: SandboxHost = {
		events: createEventBus(),
		on: vi.fn(() => vi.fn()),
		sendMessage: vi.fn(),
		appendEntry: vi.fn()
	};
	const context = {
		cwd: directory,
		sessionManager: SessionManager.inMemory(directory)
	};

	try {
		await run(pi, context);
	} finally {
		await closeSandboxSession(pi, context);
		await rm(directory, { recursive: true, force: true });
	}
}

function provider(id: string, backend: MemoryBackend): SandboxProvider<object> {
	return {
		id,
		label: id,
		protocolVersion: 1,
		defaultPolicy: backend.policy,
		capabilities: backend.capabilities,
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		validateConfig: () => ({}),
		open: () => Promise.resolve(backend)
	};
}

it('activates a provider without a configuration file and shares lazy resolution', async () => {
	await fixture(async (pi, context) => {
		const backend = new MemoryBackend();
		const configure = vi.fn(() => ({
			configuration: {},
			policy: backend.policy
		}));

		registerSandboxProvider(pi, provider('active', backend), { configure });

		const sandboxes = await Promise.all([
			getSandbox(pi, context),
			getSandbox(pi, context)
		]);

		expect({
			providers: sandboxes.map((sandbox) => sandbox.providerId),
			resolutions: configure.mock.calls.length
		}).toStrictEqual({ providers: ['active', 'active'], resolutions: 1 });
	});
});

it('rejects distinct activated providers before configuration or allocation', async () => {
	await fixture(async (pi, context) => {
		const backend = new MemoryBackend();
		const configure = vi.fn(() => ({ configuration: {} }));

		for (const id of ['first', 'second']) {
			registerSandboxProvider(pi, provider(id, backend), { configure });
		}

		await expect(getSandbox(pi, context)).rejects.toMatchObject({
			name: 'ConflictingSandboxProviderError'
		});
		expect(configure.mock.calls).toStrictEqual([]);
	});
});

it('retains configuration failure without opening or selecting passthrough', async () => {
	await fixture(async (pi, context) => {
		const backend = new MemoryBackend();
		const open = vi.fn(() => Promise.resolve(backend));
		const configure = vi.fn(() => {
			throw new Error('private extension setting');
		});

		registerSandboxProvider(
			pi,
			{ ...provider('failed', backend), open },
			{ configure }
		);

		for (const _attempt of [1, 2]) {
			await expect(getSandbox(pi, context)).rejects.toMatchObject({
				name: 'InvalidSandboxConfigError',
				providerId: 'failed',
				configurationSource: 'extension'
			});
		}

		expect({
			resolutions: configure.mock.calls.length,
			openings: open.mock.calls.length
		}).toStrictEqual({ resolutions: 1, openings: 0 });
	});
});

it('rejects registration after configuration has started', async () => {
	await fixture(async (pi, context) => {
		await getSandbox(pi, context);
		expect(() => {
			registerSandboxProvider(pi, provider('late', new MemoryBackend()));
		}).toThrow(expect.objectContaining({ name: 'InvalidSandboxRequestError' }));
	});
});

it('keeps shared configuration running when one caller cancels', async () => {
	await fixture(async (pi, context) => {
		const backend = new MemoryBackend();
		const entered = Promise.withResolvers<AbortSignal>();
		const configured = Promise.withResolvers<{ configuration: object }>();

		registerSandboxProvider(pi, provider('active', backend), {
			configure: (scope) => {
				entered.resolve(scope.signal);

				return configured.promise;
			}
		});

		const controller = new AbortController();
		const cancelled = getSandbox(pi, context, { signal: controller.signal });
		const signal = await entered.promise;
		const other = getSandbox(pi, context);

		controller.abort();
		await expect(cancelled).rejects.toMatchObject({
			name: 'SandboxCancelledError'
		});
		configured.resolve({ configuration: {} });

		const sandbox = await other;

		expect({
			aborted: signal.aborted,
			providerId: sandbox.providerId
		}).toStrictEqual({ aborted: false, providerId: 'active' });
	});
});

it.each(['success', 'failure'] as const)(
	'retains configuration diagnostics after resolver %s and ignores late reports',
	async (outcome) => {
		await fixture(async (pi, context) => {
			const backend = new MemoryBackend();
			const reports: SandboxConfigContext[] = [];
			const configure = vi.fn((scope: SandboxConfigContext) => {
				reports.push(scope);
				scope.reportDiagnostic({
					level: 'warning',
					message: 'sandbox-settings.json: runtime must be a string.'
				});

				if (outcome === 'failure') {
					throw new Error('PRIVATE_CONFIGURATION_VALUE');
				}

				return { configuration: {} };
			});

			registerSandboxProvider(pi, provider('active', backend), { configure });

			const acquired = getSandbox(pi, context);

			if (outcome === 'failure') {
				await expect(acquired).rejects.toMatchObject({
					name: 'InvalidSandboxConfigError'
				});
			} else {
				await acquired;
			}

			const broker = discoverBroker(pi.events);
			const status = await broker?.status(context);

			for (const scope of reports) {
				scope.reportDiagnostic({ level: 'warning', message: 'Late warning' });
			}

			const after = await broker?.status(context);
			const operationId: unknown = expect.any(String);

			expect({
				diagnostics: status?.diagnostics,
				after: after?.diagnostics,
				resolutions: configure.mock.calls.length
			}).toStrictEqual({
				diagnostics: [
					{
						operation: 'configure',
						operationId,
						providerId: 'active',
						level: 'warning',
						message: 'sandbox-settings.json: runtime must be a string.'
					}
				],
				after: [
					{
						operation: 'configure',
						operationId,
						providerId: 'active',
						level: 'warning',
						message: 'sandbox-settings.json: runtime must be a string.'
					}
				],
				resolutions: 1
			});

			if (status === undefined) {
				throw new Error('The SDK did not publish a status.');
			}

			const display = formatStatus(status);

			expect(display).toContain(
				'sandbox-settings.json: runtime must be a string.'
			);
			expect(display).not.toContain('PRIVATE_CONFIGURATION_VALUE');
		});
	}
);

it('keeps raw registration input separate from transformed provider configuration', async () => {
	await fixture(async (pi, context) => {
		registerSandboxProvider<{ endpoint: URL }, { endpoint: string }>(
			pi,
			connectionProvider,
			{
				configure: () => ({
					configuration: { endpoint: 'https://fixture.invalid' },
					policy: {
						workspaceAccess: 'read-write',
						filesystemScope: 'workspace-only',
						networkAccess: 'denied'
					}
				})
			}
		);

		const sandbox = await getSandbox(pi, context);

		expect({
			provider: sandbox.providerId,
			backend: sandbox.backendId
		}).toStrictEqual({
			provider: 'fixture.connection',
			backend: 'fixture.invalid'
		});
	});
});

it('shares one diagnostic allowance between configuration and execution', async () => {
	await fixture(async (pi, context) => {
		const backend = new MemoryBackend('exec');

		backend.exec = (_request, execution) => {
			for (const index of [0, 1, 2]) {
				execution.reportDiagnostic({
					level: 'warning',
					message: `execution ${String(index)}`
				});
			}

			return Promise.resolve({
				kind: 'exited',
				exit: { kind: 'code', code: 0 }
			});
		};

		registerSandboxProvider(pi, provider('active', backend), {
			configure: (scope) => {
				for (let index = 0; index < 63; index++) {
					scope.reportDiagnostic({
						level: 'warning',
						message: `configuration ${String(index)}`
					});
				}

				return { configuration: {} };
			}
		});

		const sandbox = await getSandbox(pi, context);

		await sandbox.exec({ kind: 'argv', executable: 'probe', args: [] });

		const status = await discoverBroker(pi.events)?.status(context);

		expect({
			messages: status?.diagnostics?.map((entry) => entry.message),
			dropped: status?.diagnosticsDropped
		}).toStrictEqual({
			messages: [
				...Array.from(
					{ length: 63 },
					(_value, index) => `configuration ${String(index)}`
				),
				'execution 0'
			],
			dropped: 2
		});
	});
});
