import { expect, it, vi } from 'vitest';

import type { SandboxBackend } from './contracts.js';
import { SandboxCleanupError } from './errors.js';
import { contractScenario } from './fixtures/provider-contract.js';
import {
	providerContractCases,
	usingProviderFixture
} from './provider-contract-suite.js';
import type { SandboxProviderTestOptions } from './provider-test-contracts.js';
import { defineSandboxProviderTests } from './testing.js';

defineSandboxProviderTests(contractScenario());

const shellOnly = contractScenario();
const openShellOnly = shellOnly.provider.open;

defineSandboxProviderTests({
	...shellOnly,
	label: 'shell-only provider with unavailable exit details',
	provider: {
		...shellOnly.provider,
		capabilities: {
			operations: ['exec'],
			processKinds: ['shell'],
			shells: ['sh'],
			exitStatus: 'optional'
		},
		async open(request, context) {
			const backend = await openShellOnly(request, context);
			const { files: _files, ...executionOnly } = backend;

			return {
				...executionOnly,
				capabilities: {
					operations: ['exec'],
					processKinds: ['shell'],
					shells: ['sh'],
					exitStatus: 'optional'
				},
				async exec(process, execution) {
					if (process.kind === 'shell' && process.command === 'wait') {
						return backend.exec(
							{ kind: 'argv', executable: 'wait', args: [] },
							execution
						);
					}

					await backend.exec(process, execution);

					return { kind: 'exited', exit: { kind: 'unavailable' } };
				}
			};
		}
	},
	async createFixture() {
		const { processes: _processes, ...fixture } =
			await shellOnly.createFixture();
		const sh = fixture.shells?.sh;

		if (sh === undefined) {
			throw new Error('The shell probe is missing.');
		}

		return {
			...fixture,
			shells: { sh: { ...sh, exit: { kind: 'unavailable' } } },
			cancellation: {
				...fixture.cancellation,
				request: { kind: 'shell', dialect: 'sh', command: 'wait' }
			}
		};
	}
});

it.each([
	{
		label: 'a missing advertised file group',
		change: (backend: SandboxBackend) => ({ ...backend, files: {} }),
		error: 'InvalidSandboxDeclarationError'
	},
	{
		label: 'an unsupported effective policy',
		change: (backend: SandboxBackend) => ({
			...backend,
			policy: { ...backend.policy, networkAccess: 'denied' as const }
		}),
		error: 'InvalidSandboxDeclarationError'
	}
])(
	'rejects $label and still releases the allocation',
	async ({ change, error }) => {
		const options = contractScenario();
		const open = options.provider.open;
		let isCleaned = false;

		await expect(
			usingProviderFixture(
				{
					...options,
					provider: {
						...options.provider,
						open: async (request, context) =>
							change(await open(request, context))
					},
					createFixture: async () => ({
						...(await options.createFixture()),
						cleanup: () => {
							isCleaned = true;

							return Promise.resolve();
						}
					})
				},
				() => Promise.resolve()
			)
		).rejects.toMatchObject({ name: error });
		expect(isCleaned).toBe(true);
	}
);

it.each([
	{
		label: 'fabricated execution success',
		caseName: 'argv execution',
		change: (backend: SandboxBackend): SandboxBackend => ({
			...backend,
			exec: () =>
				Promise.resolve({ kind: 'exited', exit: { kind: 'code', code: 0 } })
		})
	},
	{
		label: 'writes without target effects',
		caseName: 'file mutation',
		change: (backend: SandboxBackend): SandboxBackend => ({
			...backend,
			files: {
				...backend.files,
				write: {
					writeFile: () => Promise.resolve(),
					mkdir: () => Promise.resolve(),
					access: () => Promise.resolve()
				}
			}
		})
	},
	{
		label: 'non-idempotent disposal',
		caseName: 'idempotent disposal',
		change: (backend: SandboxBackend): SandboxBackend => {
			let isDisposed = false;

			return {
				...backend,
				dispose(context) {
					if (isDisposed) {
						return Promise.reject(
							new SandboxCleanupError({ operation: 'dispose' })
						);
					}

					isDisposed = true;

					return backend.dispose(context);
				}
			};
		}
	},
	{
		label: 'unconfirmed termination',
		caseName: 'confirmed cancellation',
		change: (backend: SandboxBackend): SandboxBackend => ({
			...backend,
			exec: async (request, context) => {
				try {
					await backend.exec(request, context);
				} catch {
					return { kind: 'cancelled', termination: 'unconfirmed' };
				}

				throw new Error('The cancellation probe unexpectedly exited.');
			}
		})
	}
])('detects $label', async ({ change, caseName }) => {
	const options = contractScenario();
	const open = options.provider.open;
	const broken = {
		...options,
		provider: {
			...options.provider,
			open: async (...arguments_: Parameters<typeof open>) =>
				change(await open(...arguments_))
		}
	};
	const selected = providerContractCases(options).find(
		(entry) => entry.label === caseName
	);

	expect(selected).toBeDefined();

	if (selected === undefined) {
		throw new Error('The expected contract case is missing.');
	}

	await expect(usingProviderFixture(broken, selected.run)).rejects.toThrow();
});

it.each(['missing', 'failing'] as const)(
	'rejects a restrictive policy with %s independent checks',
	async (verification) => {
		const options = contractScenario();
		const open = options.provider.open;
		const scenario = {
			...options,
			provider: {
				...options.provider,
				policies: {
					...options.provider.policies,
					networkAccess: ['denied'] as const
				},
				open: async (...arguments_: Parameters<typeof open>) => ({
					...(await open(...arguments_)),
					policy: {
						workspaceAccess: 'read-write',
						filesystemScope: 'provider-default',
						networkAccess: 'denied'
					} as const
				})
			},
			createFixture: async () => {
				const fixture = await options.createFixture();

				return {
					...fixture,
					policy: { ...fixture.policy, networkAccess: 'denied' as const },
					...(verification === 'failing' && {
						verifyPolicy: () => {
							expect({ hasNetworkAccess: true }).toStrictEqual({
								hasNetworkAccess: false
							});

							return Promise.resolve();
						}
					})
				};
			}
		};
		const selected = providerContractCases(scenario)[0];

		if (selected === undefined) {
			throw new Error('The metadata case is missing.');
		}

		await expect(
			usingProviderFixture(scenario, selected.run)
		).rejects.toThrow();
	}
);

it('checks target termination independently of the cancellation acknowledgement', async () => {
	const options = contractScenario();
	const scenario = {
		...options,
		createFixture: async () => {
			const fixture = await options.createFixture();

			return {
				...fixture,
				cancellation: {
					...fixture.cancellation,
					verifyStopped: () => {
						expect({ isDescendantRunning: true }).toStrictEqual({
							isDescendantRunning: false
						});

						return Promise.resolve();
					}
				}
			};
		}
	};
	const selected = providerContractCases(scenario).find(
		(entry) => entry.label === 'confirmed cancellation'
	);

	if (selected === undefined) {
		throw new Error('The cancellation case is missing.');
	}

	await expect(usingProviderFixture(scenario, selected.run)).rejects.toThrow();
});

it('preserves a failed assertion and a disposal failure while still running cleanup', async () => {
	const options = contractScenario();
	const open = options.provider.open;
	const assertion = new Error('The target result was incorrect.');
	const disposal = new Error('The target could not be released.');
	let isCleaned = false;

	await expect(
		usingProviderFixture(
			{
				...options,
				provider: {
					...options.provider,
					open: async (...arguments_: Parameters<typeof open>) => ({
						...(await open(...arguments_)),
						dispose: () => Promise.reject(disposal)
					})
				},
				createFixture: async () => ({
					...(await options.createFixture()),
					cleanup: () => {
						isCleaned = true;

						return Promise.resolve();
					}
				})
			},
			() => Promise.reject(assertion)
		)
	).rejects.toMatchObject({
		name: 'AggregateError',
		errors: [assertion, disposal]
	});
	expect(isCleaned).toBe(true);
});

it('bounds an opening that ignores its deadline and runs independent cleanup', async () => {
	vi.useFakeTimers();

	const options = contractScenario();
	let isAborted = false;
	let cleanupMs: number | undefined;
	let isCleaned = false;

	try {
		const running = usingProviderFixture(
			{
				...options,
				timeoutMs: 10,
				cleanup: { cancellationGraceMs: 8000 },
				provider: {
					...options.provider,
					open: (_request, context) => {
						context.signal.addEventListener(
							'abort',
							() => {
								isAborted = true;
								cleanupMs = (context.cleanup.deadline ?? NaN) - Date.now();
							},
							{ once: true }
						);

						return new Promise(() => {
							return;
						});
					}
				},
				createFixture: async () => ({
					...(await options.createFixture()),
					cleanup: () => {
						isCleaned = true;

						return Promise.resolve();
					}
				})
			},
			() => Promise.resolve()
		);
		const rejected = expect(running).rejects.toThrow('exceeded its deadline');

		await vi.advanceTimersByTimeAsync(11);
		await rejected;
		expect({ isAborted, isCleaned, cleanupMs }).toStrictEqual({
			isAborted: true,
			isCleaned: true,
			cleanupMs: 8000
		});
	} finally {
		vi.useRealTimers();
	}
});

it.each(['confirmed cancellation', 'idempotent disposal'])(
	'configures cleanup budgets independently of stage timeouts for %s',
	async (caseName) => {
		vi.useFakeTimers();

		const options = contractScenario();
		const open = options.provider.open;
		const observed: { operation: string; budgetMs: number | undefined }[] = [];
		const scenario = {
			...options,
			timeoutMs: 20_000,
			cleanup: { cancellationGraceMs: 12_000, disposalTimeoutMs: 15_000 },
			provider: {
				...options.provider,
				async open(request, context) {
					const backend = await open(request, context);

					return {
						...backend,
						async exec(request, execution) {
							try {
								return await backend.exec(request, execution);
							} finally {
								observed.push({
									operation: 'cancellation',
									budgetMs: (execution.cleanup.deadline ?? NaN) - Date.now()
								});
							}
						},
						dispose(disposal) {
							observed.push({
								operation: 'disposal',
								budgetMs: (disposal.cleanup.deadline ?? NaN) - Date.now()
							});

							return backend.dispose(disposal);
						}
					};
				}
			}
		} satisfies SandboxProviderTestOptions<undefined>;
		const selected = providerContractCases(scenario).find(
			(entry) => entry.label === caseName
		);

		try {
			if (selected === undefined) {
				throw new Error('The selected contract case is missing.');
			}

			await usingProviderFixture(scenario, selected.run);
			expect(observed).toStrictEqual(
				caseName === 'confirmed cancellation'
					? [
							{ operation: 'cancellation', budgetMs: 12_000 },
							{ operation: 'disposal', budgetMs: 15_000 }
						]
					: [
							{ operation: 'disposal', budgetMs: 15_000 },
							{ operation: 'disposal', budgetMs: 15_000 },
							{ operation: 'disposal', budgetMs: 15_000 }
						]
			);
		} finally {
			vi.useRealTimers();
		}
	}
);
