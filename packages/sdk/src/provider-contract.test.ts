import { expect, it, vi } from 'vitest';

import type {
	BackendProcessContext,
	ProcessRequest,
	SandboxBackend,
	SandboxOperationContext,
	SandboxPolicy
} from './contracts.js';
import { SandboxCleanupError, SandboxOperationError } from './errors.js';
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
			terminationScope: 'workload',
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
					terminationScope: 'workload',
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

const unmanaged = contractScenario();
const unmanagedOpen = unmanaged.provider.open;

defineSandboxProviderTests({
	...unmanaged,
	label: 'provider without a termination guarantee',
	provider: {
		...unmanaged.provider,
		capabilities: {
			...unmanaged.provider.capabilities,
			terminationScope: 'none'
		},
		async open(request, context) {
			const backend = await unmanagedOpen(request, context);

			return {
				...backend,
				capabilities: { ...backend.capabilities, terminationScope: 'none' },
				exec(request, execution) {
					if (request.kind === 'argv' && request.executable === 'wait') {
						execution.onOutput({
							stream: 'stdout',
							data: new TextEncoder().encode('ready')
						});

						return Promise.withResolvers<never>().promise;
					}

					return backend.exec(request, execution);
				}
			};
		}
	},
	async createFixture() {
		const fixture = await unmanaged.createFixture();
		const { verifyStopped: _verifyStopped, ...cancellation } =
			fixture.cancellation;

		return { ...fixture, cancellation };
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

it.each([
	['network', 'missing'],
	['network', 'failing'],
	['filesystem', 'missing'],
	['filesystem', 'failing'],
	['workspace', 'missing'],
	['workspace', 'failing']
] as const)(
	'rejects a restrictive %s policy with %s independent checks',
	async (restriction, verification) => {
		const options = contractScenario();
		const open = options.provider.open;
		const capabilities = {
			...options.provider.capabilities,
			operations: [
				...options.provider.capabilities.operations,
				'workspace.protection' as const
			]
		};
		const policy: SandboxPolicy = {
			...(restriction === 'workspace' && {
				workspaceProtection: [{ kind: 'git-metadata' as const }]
			}),
			workspaceAccess: 'read-write',
			filesystemScope:
				restriction === 'filesystem' ? 'system-read-only' : 'provider-default',
			networkAccess: restriction === 'network' ? 'denied' : 'provider-default'
		};
		const scenario = {
			...options,
			provider: {
				...options.provider,
				capabilities,
				policies: {
					...options.provider.policies,
					networkAccess: ['denied', 'provider-default'] as const,
					filesystemScope: ['system-read-only', 'provider-default'] as const
				},
				open: async (...arguments_: Parameters<typeof open>) => ({
					...(await open(...arguments_)),
					capabilities,
					policy
				})
			},
			createFixture: async () => {
				const fixture = await options.createFixture();

				return {
					...fixture,
					policy,
					...(verification === 'failing' && {
						verifyPolicy: () => {
							expect({ forbiddenAccess: true }).toStrictEqual({
								forbiddenAccess: false
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

it.each([
	{
		defect: 'a shared writer that exits before the host replaces the file',
		relationship: 'shared',
		expected: 'writer must wait'
	},
	{
		defect: 'a stale shared read',
		relationship: 'shared',
		expected: 'target process'
	},
	{
		defect: 'a copy written back on disposal',
		relationship: 'copied',
		expected: 'Disposing a copied workspace'
	},
	{
		defect: 'a copied write leaking to the source',
		relationship: 'copied',
		expected: 'source file'
	},
	{
		defect: 'a file reader stuck on the opening copy',
		relationship: 'copied',
		expected: 'file reader'
	}
] as const)('detects $defect', async ({ defect, relationship, expected }) => {
	const base = contractScenario();
	const open = base.provider.open;
	let source = Buffer.from('seed');
	let target = Buffer.from(source);
	const readTarget = { kind: 'argv', executable: 'read', args: [] } as const;
	const scenario = {
		...base,
		workspaceVisibility: relationship,
		capabilities: {
			...base.provider.capabilities,
			operations: ['exec', 'files.read'] as const
		},
		provider: {
			...base.provider,
			async open(...arguments_: Parameters<typeof open>) {
				const backend = await open(...arguments_);

				return {
					...backend,
					async dispose(context: SandboxOperationContext) {
						await backend.dispose(context);

						if (defect === 'a copy written back on disposal') {
							source = target;
						}
					},
					workspace: { ...backend.workspace, relationship },
					files: {
						...backend.files,
						read: {
							access: () => Promise.resolve(),
							stat: () =>
								Promise.resolve({ kind: 'file' as const, size: target.length }),
							readFile: () =>
								Promise.resolve(
									defect === 'a file reader stuck on the opening copy'
										? Buffer.from('seed')
										: target
								)
						}
					},
					exec(request: ProcessRequest, context: BackendProcessContext) {
						if (request.kind === 'argv' && request.executable === 'write') {
							target = Buffer.from(request.args[0] ?? '', 'base64');

							if (defect === 'a copied write leaking to the source') {
								source = target;
							}
						} else {
							context.onOutput({ stream: 'stdout', data: target });
						}

						return Promise.resolve({
							kind: 'exited' as const,
							exit: { kind: 'code' as const, code: 0 }
						});
					}
				};
			}
		},
		async createFixture() {
			return {
				...(await base.createFixture()),
				visibility: {
					targetPath: 'file',
					readSource: () => Promise.resolve(source),
					replaceSource: (bytes: Uint8Array) => {
						source = Buffer.from(bytes);

						if (
							defect ===
							'a shared writer that exits before the host replaces the file'
						) {
							target = source;
						}

						return Promise.resolve();
					},
					readTarget,
					waitForReplacement: () => readTarget,
					writeTarget: (bytes: Uint8Array): ProcessRequest => ({
						kind: 'argv',
						executable: 'write',
						args: [Buffer.from(bytes).toString('base64')]
					})
				}
			};
		}
	};
	const entry = providerContractCases(scenario).find(
		(item) => item.label === `workspace visibility (${relationship})`
	);

	if (!entry) {
		throw new Error('Missing workspace visibility scenario.');
	}

	await expect(usingProviderFixture(scenario, entry.run)).rejects.toThrow(
		expected
	);
});

it.each(['successful', 'missing', 'wrong output'] as const)(
	'checks a %s follow-up probe after confirmed cancellation',
	async (mode) => {
		const base = contractScenario();
		const scenario = {
			...base,
			verifyRecoveryAfterCancellation: true,
			async createFixture() {
				const fixture = await base.createFixture();

				return {
					...fixture,
					cancellation: {
						...fixture.cancellation,
						...(mode !== 'missing' && {
							after: {
								request: { kind: 'argv' as const, executable: 'pwd', args: [] },
								stdout: Buffer.from(
									mode === 'successful' ? '/remote/project\n' : 'wrong'
								),
								stderr: new Uint8Array(),
								exit: { kind: 'code' as const, code: 0 }
							}
						})
					}
				};
			}
		};
		const entry = providerContractCases(scenario).find(
			(item) => item.label === 'confirmed cancellation and continued use'
		);

		if (!entry) {
			throw new Error('Missing cancellation recovery scenario.');
		}

		const run = usingProviderFixture(scenario, entry.run);

		if (mode === 'successful') {
			await run;

			return;
		}

		await expect(run).rejects.toThrow(
			mode === 'missing' ? 'Supply a process' : /to strictly equal/
		);
	}
);

it('rejects a recovery scenario without a termination guarantee before opening', () => {
	const base = contractScenario();

	expect(() =>
		providerContractCases({
			...base,
			capabilities: { ...base.provider.capabilities, terminationScope: 'none' },
			verifyRecoveryAfterCancellation: true
		})
	).toThrow('Continued use requires confirmed termination.');
});

it('detects disposal that also closes a second allocation from the same source', async () => {
	const base = contractScenario();
	const { open } = base.provider;
	let isClosed = false;
	const options = {
		...base,
		verifyIndependentAllocations: true,
		provider: {
			...base.provider,
			async open(...arguments_: Parameters<typeof open>) {
				const backend = await open(...arguments_);

				return {
					...backend,
					async exec(request: ProcessRequest, context: BackendProcessContext) {
						if (isClosed) {
							throw new Error('The peer is closed.');
						}

						return backend.exec(request, context);
					},
					async dispose(context: SandboxOperationContext) {
						isClosed = true;
						await backend.dispose(context);
					}
				};
			}
		},
		async createFixture() {
			const fixture = await base.createFixture();
			const peerProcess = fixture.processes?.[0];

			if (peerProcess === undefined) {
				throw new Error('Missing fixture process.');
			}

			return {
				...fixture,
				peerProcess,
				verifyAllocationDisposed: fixture.verifyDisposed
			};
		}
	};
	const scenario = providerContractCases(options).find(
		(entry) =>
			entry.label === 'independent disposal of allocations from the same source'
	);

	if (scenario === undefined) {
		throw new Error('Missing allocation disposal scenario.');
	}

	await expect(usingProviderFixture(options, scenario.run)).rejects.toThrow(
		'The peer is closed.'
	);
});

it('requires a peer job when checking concurrent cancellation', async () => {
	const scenario = {
		...contractScenario(),
		verifyConcurrentCancellation: true
	};
	const entry = providerContractCases(scenario).find(
		(item) => item.label === 'cancellation leaves a concurrent job running'
	);

	expect(entry).toBeDefined();

	if (!entry) {
		throw new Error('Missing concurrent cancellation scenario.');
	}

	await expect(usingProviderFixture(scenario, entry.run)).rejects.toThrow(
		'Supply a concurrent job'
	);
});

it.each(['survives', 'exits early', 'cancelled'] as const)(
	'checks whether a concurrent job survives cancellation (%s)',
	async (mode) => {
		const base = contractScenario();
		const open = base.provider.open;
		const gate = Promise.withResolvers<Uint8Array>();
		const ready = Buffer.from('waiting');
		const request = { kind: 'argv', executable: 'peer', args: [] } as const;
		const scenario = {
			...base,
			verifyConcurrentCancellation: true,
			async createFixture() {
				return {
					...(await base.createFixture()),
					concurrentJob: {
						request,
						ready,
						release: (bytes: Uint8Array) => {
							gate.resolve(bytes);

							return Promise.resolve();
						}
					}
				};
			},
			provider: {
				...base.provider,
				async open(...arguments_: Parameters<typeof open>) {
					const backend = await open(...arguments_);

					return {
						...backend,
						async exec(
							process: ProcessRequest,
							context: BackendProcessContext
						) {
							if (process.kind !== 'argv' || process.executable !== 'peer') {
								if (mode !== 'survives') {
									context.signal.addEventListener(
										'abort',
										() => {
											gate.resolve(new Uint8Array());
										},
										{ once: true }
									);
								}

								return backend.exec(process, context);
							}

							context.onOutput({ stream: 'stdout', data: ready });

							const bytes = await gate.promise;

							if (mode === 'cancelled') {
								return {
									kind: 'cancelled' as const,
									termination: 'confirmed' as const
								};
							}

							context.onOutput({ stream: 'stdout', data: bytes });

							return {
								kind: 'exited' as const,
								exit: { kind: 'code' as const, code: 0 }
							};
						}
					};
				}
			}
		};
		const entry = providerContractCases(scenario).find(
			(item) => item.label === 'cancellation leaves a concurrent job running'
		);

		if (!entry) {
			throw new Error('Missing concurrent cancellation scenario.');
		}

		const result = usingProviderFixture(scenario, entry.run);

		if (mode === 'survives') {
			await result;

			return;
		}

		await expect(result).rejects.toThrow(
			'The same peer must return the response'
		);
	}
);

it.each([
	'read-only',
	'protected-path',
	'protected-alias',
	'late-special-file',
	'denied-network'
] as const)(
	'requires an independent probe for the selected %s restriction',
	async (restriction) => {
		const scenario = { ...contractScenario(), policyEffects: [restriction] };
		const entry = providerContractCases(scenario).find(
			(test) => test.label === 'policy effects (' + restriction + ')'
		);

		if (!entry) {
			throw new Error('Missing policy effects scenario.');
		}

		await expect(usingProviderFixture(scenario, entry.run)).rejects.toThrow(
			'Supply a policy effect probe'
		);
	}
);

it.each([false, true])(
	'observes listener connections independently of the denied exit status (%s)',
	async (connected) => {
		const base = contractScenario();
		const open = base.provider.open;
		let connections = 1;
		const scenario: SandboxProviderTestOptions<undefined> = {
			...base,
			policyEffects: ['denied-network'],
			provider: {
				...base.provider,
				policies: { ...base.provider.policies, networkAccess: ['denied'] },
				async open(...arguments_) {
					const backend = await open(...arguments_);

					return {
						...backend,
						policy: { ...backend.policy, networkAccess: 'denied' },
						exec(request, context) {
							if (
								connected &&
								request.kind === 'argv' &&
								request.executable === 'probe'
							) {
								connections++;
							}

							return backend.exec(request, context);
						}
					};
				}
			},
			async createFixture() {
				const fixture = await base.createFixture();
				const denied = fixture.processes?.[0];

				if (!denied) {
					throw new Error('Missing denied command fixture.');
				}

				return {
					...fixture,
					policy: { ...fixture.policy, networkAccess: 'denied' },
					policyEffects: {
						'denied-network': () =>
							Promise.resolve({
								permitted: {
									request: { kind: 'argv', executable: 'pwd', args: [] },
									exit: { kind: 'code', code: 0 },
									stdout: Buffer.from('/remote/project\n'),
									stderr: Buffer.alloc(0)
								},
								denied,
								observe: () =>
									Promise.resolve({ kind: 'listener', connections })
							})
					}
				};
			}
		};
		const entry = providerContractCases(scenario).find(
			(test) => test.label === 'policy effects (denied-network)'
		);

		if (!entry) {
			throw new Error('Missing network policy check.');
		}

		const result = usingProviderFixture(scenario, entry.run);

		if (connected) {
			await expect(result).rejects.toThrow(
				'The denied process changed the protected resource.'
			);

			return;
		}

		await result;
	}
);

it('waits for a cancelled scenario to release its active job before disposal', async () => {
	vi.useFakeTimers();

	const base = contractScenario();
	let isPending = false;
	const events: string[] = [];

	try {
		const run = usingProviderFixture(
			{
				...base,
				timeoutMs: 50,
				cleanup: { cancellationGraceMs: 100 },
				provider: {
					...base.provider,
					async open(...arguments_) {
						const backend = await base.provider.open(...arguments_);

						return {
							...backend,
							async dispose(context) {
								events.push(isPending ? 'disposed while running' : 'disposed');
								await backend.dispose(context);
							}
						};
					}
				}
			},
			async (_fixture, _backend, context) => {
				isPending = true;
				await new Promise<void>((resolve) => {
					context.signal.addEventListener(
						'abort',
						() => setTimeout(resolve, 25),
						{ once: true }
					);
				});
				isPending = false;
				events.push('stopped');

				throw new Error('The cancelled operation stopped.');
			}
		);
		const rejected = expect(run).rejects.toThrow(
			'The provider contract operation exceeded its deadline.'
		);

		await vi.advanceTimersByTimeAsync(200);
		await rejected;
		expect(events).toStrictEqual(['stopped', 'disposed']);
	} finally {
		vi.useRealTimers();
	}
});

it('checks the first allocation was released before disposing the second', async () => {
	const base = contractScenario();
	const active = new Set<string>();
	const verifyAllocationDisposed = vi.fn((backend: SandboxBackend) => {
		expect(
			active.has(backend.id),
			'The disposed allocation still exists.'
		).toBe(false);

		return Promise.resolve();
	});

	const options: SandboxProviderTestOptions<undefined> = {
		...base,
		verifyIndependentAllocations: true,
		provider: {
			...base.provider,
			async open(...arguments_) {
				const backend = await base.provider.open(...arguments_);
				const id = arguments_[0].generationId;

				active.add(id);

				return {
					...backend,
					id,
					async dispose(context) {
						if (active.size === 1) {
							active.delete(id);
						}

						await backend.dispose(context);
					}
				};
			}
		},
		async createFixture() {
			const fixture = await base.createFixture();
			const peerProcess = fixture.processes?.[0];

			if (!peerProcess) {
				throw new Error('Missing peer process.');
			}

			return {
				...fixture,
				peerProcess,
				verifyAllocationDisposed
			};
		}
	};
	const entry = providerContractCases(options).find(
		(test) =>
			test.label === 'independent disposal of allocations from the same source'
	);

	if (!entry) {
		throw new Error('Missing independent disposal case.');
	}

	await expect(usingProviderFixture(options, entry.run)).rejects.toThrow(
		'The disposed allocation still exists.'
	);
	expect(verifyAllocationDisposed.mock.contexts).toMatchObject([
		{ verifyAllocationDisposed }
	]);
});

it.each([
	{ kind: 'special', count: 0, succeeds: false },
	{ kind: 'listener', count: 0, succeeds: false },
	{ kind: 'special', count: 1, succeeds: true }
] as const)(
	'verifies the independent control for a late $kind with count $count',
	async ({ kind, count, succeeds }) => {
		const base = contractScenario();
		const options: SandboxProviderTestOptions<undefined> = {
			...base,
			policyEffects: ['late-special-file'],
			provider: {
				...base.provider,
				async open(...arguments_) {
					const backend = await base.provider.open(...arguments_);
					const read = backend.files?.read;

					if (!read) {
						throw new Error('Missing read fixture.');
					}

					return {
						...backend,
						files: {
							...backend.files,
							read: {
								...read,
								readFile: () =>
									Promise.reject(
										new SandboxOperationError({ operation: 'readFile' })
									)
							}
						}
					};
				}
			},
			async createFixture() {
				const fixture = await base.createFixture();
				const denied = fixture.processes?.[0];

				if (!denied) {
					throw new Error('Missing denied command fixture.');
				}

				return {
					...fixture,
					policyEffects: {
						'late-special-file': () =>
							Promise.resolve({
								permitted: {
									request: { kind: 'argv', executable: 'pwd', args: [] },
									exit: { kind: 'code', code: 0 },
									stdout: Buffer.from('/remote/project\n'),
									stderr: Buffer.alloc(0)
								},
								denied,
								file: { path: 'late', error: 'unsupported-file' },
								observe: () =>
									Promise.resolve(
										kind === 'listener'
											? { kind, connections: count }
											: { kind, bytesReceived: count, links: 1, mode: 0o600 }
									)
							})
					}
				};
			}
		};
		const entry = providerContractCases(options).find(
			(test) => test.label === 'policy effects (late-special-file)'
		);

		if (!entry) {
			throw new Error('Missing late special file scenario.');
		}

		const result = usingProviderFixture(options, entry.run);

		if (succeeds) {
			await result;

			return;
		}

		await expect(result).rejects.toThrow('independent control');
	}
);
