import { setTimeout as delay } from 'node:timers/promises';

import { expect, it, vi } from 'vitest';

import type {
	BackendProcessContext,
	ProcessRequest,
	SandboxBackend,
	SandboxOperationContext,
	SandboxPolicy
} from './contracts.js';
import type { RecoveryDescriptor } from './contracts.js';
import { SandboxCleanupError, SandboxOperationError } from './errors.js';
import { firstOpenProfile } from './fixtures/profile-fixture.js';
import { contractScenario } from './fixtures/provider-contract.js';
import { usingRawProviderFixture as usingProviderFixture } from './fixtures/raw-provider-contract.js';
import { observe } from './lifecycle.js';
import type { AccessProperty } from './policy-model.js';
import {
	providerContractCases,
	usingProviderFixture as usingBrokerProviderFixture
} from './provider-contract-suite.js';
import { verifyUndeclaredCredentialGrant } from './provider-credential-suite.js';
import type { SandboxProviderTestOptions } from './provider-test-contracts.js';
import { defineSandboxProviderTests } from './testing.js';

defineSandboxProviderTests(contractScenario());

it('checks undeclared credential grant kinds without opening a backend', async () => {
	const scenario = contractScenario();
	const profile = {
		...firstOpenProfile(scenario.provider),
		pathGrantKinds: ['read', 'write'] as const,
		credentialPathGrantKinds: ['read'] as const
	};

	await verifyUndeclaredCredentialGrant(
		scenario,
		{ mode: 'open', profile },
		'write'
	);
});

it('opens the fixture provider through the broker and verifies the backend allocation', async () => {
	const scenario = contractScenario();
	const selected: {
		id: string | undefined;
		recovery: RecoveryDescriptor | undefined;
	}[] = [];
	const opened: SandboxBackend[] = [];
	const original = scenario.provider;
	const originalOpen = original.create().open;
	const provider = {
		...original,
		create: () => ({
			...original.create(),
			async open(
				request: Parameters<typeof originalOpen>[0],
				context: Parameters<typeof originalOpen>[1]
			) {
				const backend = await originalOpen(request, context);

				opened.push(backend);

				return backend;
			}
		})
	};
	const unused = {
		...original,
		create: () => ({
			...original.create(),
			open() {
				throw new Error(
					'The declaration must not open a backend for a fixture.'
				);
			}
		})
	};

	await usingBrokerProviderFixture(
		{
			...scenario,
			provider: unused,
			async createFixture() {
				const fixture = await scenario.createFixture();

				return {
					...fixture,
					provider,
					async verifyDisposed(
						backend?: SandboxBackend,
						recovery?: RecoveryDescriptor
					) {
						await fixture.verifyDisposed();
						selected.push({ id: backend?.id, recovery });
					}
				};
			}
		},
		async (_fixture, backend, context) => {
			const raw = opened[0];

			expect({ isWrapped: backend !== raw, id: backend.id }).toStrictEqual({
				isWrapped: true,
				id: raw?.id
			});
			await backend.files?.read?.stat('seed', context);
		}
	);

	expect(selected).toStrictEqual(
		opened.map((backend) => ({
			id: backend.id,
			recovery: backend.recovery
		}))
	);
});

const shellOnly = contractScenario();
const openShellOnly = shellOnly.provider.create().open;

defineSandboxProviderTests({
	...shellOnly,
	label: 'shell-only provider with unavailable exit details',
	provider: {
		...shellOnly.provider,
		profiles: {
			open: [
				{
					...firstOpenProfile(shellOnly.provider),
					capabilities: [],
					processKinds: ['shell'],
					shells: ['sh'],
					terminationScope: 'workload',
					exitStatus: 'optional'
				}
			],
			copy: []
		},
		create: () => ({
			...shellOnly.provider.create(),
			async open(request, context) {
				const backend = await openShellOnly(request, context);
				const { files: _files, ...executionOnly } = backend;

				return {
					...executionOnly,
					profile: request.profile,
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
		})
	},
	async createFixture(selection) {
		const { processes: _processes, ...fixture } =
			await shellOnly.createFixture(selection);
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
			profile: {
				...backend.profile,
				policy: { ...backend.profile.policy, network: false }
			}
		}),
		error: 'InvalidSandboxDeclarationError'
	}
])(
	'rejects $label and still releases the allocation',
	async ({ change, error }) => {
		const options = contractScenario();
		const open = options.provider.create().open;
		let isCleaned = false;

		await expect(
			usingProviderFixture(
				{
					...options,
					provider: {
						...options.provider,
						create: () => ({
							...options.provider.create(),
							open: async (request, context) =>
								change(await open(request, context))
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
	const open = options.provider.create().open;
	const broken = {
		...options,
		provider: {
			...options.provider,
			create: () => ({
				...options.provider.create(),
				open: async (...arguments_: Parameters<typeof open>) =>
					change(await open(...arguments_))
			})
		}
	};
	const selected = providerContractCases(options).find(
		(entry) => entry.label === caseName
	);

	expect(selected).toBeDefined();

	if (selected === undefined) {
		throw new Error('The expected contract case is missing.');
	}

	await expect(usingProviderFixture(broken, selected)).rejects.toThrow();
});

const restrictions = {
	hostWorkspaceWrites: false,
	network: false,
	hostUserData: 'denied',
	hostSystemFiles: 'denied'
} as const satisfies Record<AccessProperty, SandboxPolicy[AccessProperty]>;

it.each(
	Object.entries(restrictions).flatMap(([property, denied]) =>
		(['missing', 'failing'] as const).map(
			(verification) => [property, denied, verification] as const
		)
	)
)(
	'rejects a restrictive %s policy without successful independent checks',
	async (property, denied, verification) => {
		const options = contractScenario();
		const open = options.provider.create().open;
		const base = firstOpenProfile(options.provider);
		const policy = { ...base.policy, [property]: denied };
		const profile = { ...base, policy };

		const scenario = {
			...options,
			provider: {
				...options.provider,
				profiles: { open: [profile], copy: [] },
				create: () => ({
					...options.provider.create(),
					open: async (...arguments_: Parameters<typeof open>) => ({
						...(await open(...arguments_)),
						profile
					})
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

		await expect(usingProviderFixture(scenario, selected)).rejects.toThrow();
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

	await expect(usingProviderFixture(scenario, selected)).rejects.toThrow();
});

it('preserves a failed assertion and a disposal failure while still running cleanup', async () => {
	const options = contractScenario();
	const open = options.provider.create().open;
	const assertion = new Error('The target result was incorrect.');
	const disposal = new Error('The target could not be released.');
	let isCleaned = false;

	await expect(
		usingProviderFixture(
			{
				...options,
				provider: {
					...options.provider,
					create: () => ({
						...options.provider.create(),
						open: async (...arguments_: Parameters<typeof open>) => ({
							...(await open(...arguments_)),
							dispose: () => Promise.reject(disposal)
						})
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
					create: () => ({
						...options.provider.create(),
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
		const open = options.provider.create().open;
		const observed: { operation: string; budgetMs: number | undefined }[] = [];
		const scenario = {
			...options,
			timeoutMs: 20_000,
			cleanup: { cancellationGraceMs: 12_000, disposalTimeoutMs: 15_000 },
			provider: {
				...options.provider,
				create: () => ({
					...options.provider.create(),
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
				})
			}
		} satisfies SandboxProviderTestOptions<undefined>;
		const selected = providerContractCases(scenario).find(
			(entry) => entry.label === caseName
		);

		try {
			if (selected === undefined) {
				throw new Error('The selected contract case is missing.');
			}

			await usingProviderFixture(scenario, selected);
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
		defect: 'an editor changing the other hard link',
		relationship: 'shared',
		expected: 'surviving hard link'
	},
	{
		defect: 'a target discarding its prepared editor save',
		relationship: 'copied',
		expected: 'completed editor save'
	},
	{
		defect: 'an editor replacing the target during preparation',
		relationship: 'copied',
		expected: 'Preparing an editor save'
	},
	{
		defect: 'a completed shared editor save missing from the source',
		relationship: 'shared',
		expected: 'completed editor save'
	},
	{
		defect: 'a shared writer that never reports readiness',
		relationship: 'shared',
		expected: 'writer must wait'
	},
	{
		defect: 'a shared writer that exits before the host replaces the file',
		relationship: 'shared',
		expected: 'writer must wait'
	},
	{
		defect: 'a stale shared read',
		relationship: 'shared',
		expected: 'fresh target process'
	},
	{
		defect: 'a temporarily partial shared read',
		relationship: 'shared',
		expected: undefined
	},
	{
		defect: 'a complete read after late startup',
		relationship: 'shared',
		expected: undefined
	},
	{
		defect: 'a stale polling read after the visibility window',
		relationship: 'shared',
		expected: 'stale read'
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
] as const)('checks $defect', async ({ defect, relationship, expected }) => {
	const base = contractScenario();
	const open = base.provider.create().open;
	const initialBytes = Buffer.from('seed');
	let source = Buffer.from(initialBytes);
	let target = Buffer.from(source);
	let partial: Buffer | undefined;
	let links = 2;
	const hasLateStartup = defect === 'a complete read after late startup';
	const hasStalePollingRead =
		defect === 'a stale polling read after the visibility window';
	const hasPollingProbe = hasLateStartup || hasStalePollingRead;
	const readTarget = { kind: 'argv', executable: 'read', args: [] } as const;
	const writeTarget = (bytes: Uint8Array): ProcessRequest => ({
		kind: 'argv',
		executable: 'write',
		args: [Buffer.from(bytes).toString('base64')]
	});
	const originalProfile = firstOpenProfile(base.provider);
	const baseProfile =
		hasPollingProbe || defect === 'a temporarily partial shared read'
			? {
					...originalProfile,
					policy: { ...originalProfile.policy, hostWorkspaceWrites: false }
				}
			: originalProfile;
	const copyProfile = {
		...baseProfile,
		policy: { ...baseProfile.policy, hostWorkspaceWrites: false }
	};
	const openWithVisibility = async (...arguments_: Parameters<typeof open>) => {
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
			async exec(request: ProcessRequest, context: BackendProcessContext) {
				if (request.kind === 'argv' && request.executable === 'wait') {
					return Promise.withResolvers<never>().promise;
				}

				if (request.kind === 'argv' && request.executable === 'poll') {
					if (hasLateStartup) {
						await delay(1100);
					}

					const sample = hasStalePollingRead
						? `1100\t1101\t${initialBytes.toString('base64')}\n`
						: `0\t1\t${target.toString('base64')}\n`;

					context.onOutput({ stream: 'stdout', data: Buffer.from(sample) });
				} else if (request.kind === 'argv' && request.executable === 'write') {
					target = Buffer.from(request.args[0] ?? '', 'base64');

					if (defect === 'an editor changing the other hard link') {
						links--;
					}

					if (
						defect === 'a copied write leaking to the source' ||
						defect === 'an editor changing the other hard link'
					) {
						source = target;
					}
				} else {
					context.onOutput({ stream: 'stdout', data: partial ?? target });
					partial = undefined;
				}

				return {
					kind: 'exited' as const,
					exit: { kind: 'code' as const, code: 0 }
				};
			}
		};
	};

	const scenario = {
		...base,
		workspaceVisibility: relationship,
		timeoutMs: hasPollingProbe || defect === 'a stale shared read' ? 2000 : 500,
		cleanup: { cancellationGraceMs: 5, disposalTimeoutMs: 100 },
		capabilities: {
			...firstOpenProfile(base.provider),
			capabilities: ['files.read'] as const
		},
		provider: {
			...base.provider,
			profiles: { open: [baseProfile], copy: [copyProfile] },
			create: () => ({
				...base.provider.create(),
				open: openWithVisibility,
				copy: openWithVisibility
			})
		},
		async createFixture() {
			return {
				...(await base.createFixture()),
				visibility: {
					targetPath: 'file',
					...(defect === 'an editor changing the other hard link' && {
						stageSave: (bytes: Uint8Array) => ({
							prepare: readTarget,
							commit: writeTarget(bytes)
						}),
						linkSource: () =>
							Promise.resolve(() =>
								Promise.resolve({
									identity: 'original',
									content: new Uint8Array(source),
									mode: 0o644,
									uid: 42,
									gid: 42,
									links
								})
							)
					}),
					...(defect === 'a target discarding its prepared editor save' && {
						stageSave: () => ({ prepare: readTarget, commit: readTarget })
					}),
					...(defect ===
						'an editor replacing the target during preparation' && {
						stageSave: (bytes: Uint8Array) => ({
							prepare: writeTarget(bytes),
							commit: readTarget
						})
					}),
					...(defect ===
						'a completed shared editor save missing from the source' && {
						stageSave: (bytes: Uint8Array) => ({
							prepare: readTarget,
							commit: writeTarget(bytes)
						})
					}),
					readSource: () => Promise.resolve(source),
					replaceSource: (bytes: Uint8Array) => {
						source = Buffer.from(bytes);

						if (relationship === 'shared' && defect !== 'a stale shared read') {
							target = source;
						}

						if (defect === 'a temporarily partial shared read') {
							partial = target.subarray(0, 4);
						}

						return Promise.resolve();
					},
					readTarget,
					...(hasPollingProbe && {
						pollHostReplacement: (): ProcessRequest => ({
							kind: 'argv',
							executable: 'poll',
							args: []
						})
					}),
					waitForReplacement: (): ProcessRequest =>
						defect === 'a shared writer that never reports readiness'
							? { kind: 'argv', executable: 'wait', args: [] }
							: readTarget,
					writeTarget
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

	if (expected === undefined) {
		await expect(
			usingProviderFixture(scenario, entry)
		).resolves.toBeUndefined();

		return;
	}

	if (defect === 'a stale shared read' || hasStalePollingRead) {
		await expect(usingProviderFixture(scenario, entry)).rejects.toThrow(
			expected
		);

		return;
	}

	vi.useFakeTimers();

	try {
		const outcome = observe(usingProviderFixture(scenario, entry));

		await vi.advanceTimersByTimeAsync(1000);
		expect(await outcome).toHaveProperty(
			'error.message',
			expect.stringContaining(expected)
		);
	} finally {
		vi.useRealTimers();
	}
});

it.each(['successful', 'missing', 'wrong output', 'failed command'] as const)(
	'checks a %s follow-up probe after confirmed cancellation',
	async (mode) => {
		const base = contractScenario();
		const scenario = {
			...base,
			verifyRecoveryAfterCancellation: true,
			async createFixture() {
				const fixture = await base.createFixture();
				const failed = fixture.processes?.[0];

				if (!failed) {
					throw new Error('Missing failing process fixture.');
				}

				return {
					...fixture,
					cancellation: {
						...fixture.cancellation,
						...(mode !== 'missing' && {
							after:
								mode === 'failed command'
									? failed
									: {
											request: {
												kind: 'argv' as const,
												executable: 'pwd',
												args: []
											},
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

		const run = usingProviderFixture(scenario, entry);

		if (mode === 'successful') {
			await run;

			return;
		}

		await expect(run).rejects.toThrow(
			mode === 'missing' ? 'Supply a process' : /to strictly equal/
		);
	}
);

it('detects disposal that also closes a second allocation from the same source', async () => {
	const base = contractScenario();
	const { open } = base.provider.create();
	let isClosed = false;
	const options = {
		...base,
		verifyIndependentAllocations: true,
		provider: {
			...base.provider,
			create: () => ({
				...base.provider.create(),
				async open(...arguments_: Parameters<typeof open>) {
					const backend = await open(...arguments_);

					return {
						...backend,
						async exec(
							request: ProcessRequest,
							context: BackendProcessContext
						) {
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
			})
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

	await expect(usingProviderFixture(options, scenario)).rejects.toThrow(
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

	await expect(usingProviderFixture(scenario, entry)).rejects.toThrow(
		'Supply a concurrent job'
	);
});

it.each(['survives', 'exits early', 'cancelled', 'leaks job'] as const)(
	'checks whether a concurrent job survives cancellation (%s)',
	async (mode) => {
		const base = contractScenario();
		const open = base.provider.create().open;
		const gate = Promise.withResolvers<Uint8Array>();
		const ready = Buffer.from('waiting');
		const request = { kind: 'argv', executable: 'peer', args: [] } as const;
		const scenario = {
			...base,
			verifyConcurrentCancellation: true,
			async createFixture() {
				const fixture = await base.createFixture();

				return {
					...fixture,
					cancellation: {
						...fixture.cancellation,
						verifyStopped: async () => {
							if (mode === 'leaks job') {
								throw new Error('The cancelled job is still running.');
							}

							await fixture.cancellation.verifyStopped?.();
						}
					},
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
				create: () => ({
					...base.provider.create(),
					async open(...arguments_: Parameters<typeof open>) {
						const backend = await open(...arguments_);

						return {
							...backend,
							async exec(
								process: ProcessRequest,
								context: BackendProcessContext
							) {
								if (process.kind !== 'argv' || process.executable !== 'peer') {
									if (mode === 'cancelled' || mode === 'exits early') {
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

								context.signal.addEventListener(
									'abort',
									() => {
										gate.resolve(new Uint8Array());
									},
									{ once: true }
								);
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
				})
			}
		};
		const entry = providerContractCases(scenario).find(
			(item) => item.label === 'cancellation leaves a concurrent job running'
		);

		if (!entry) {
			throw new Error('Missing concurrent cancellation scenario.');
		}

		const result = usingProviderFixture(scenario, entry);

		if (mode === 'survives') {
			await result;

			return;
		}

		await expect(result).rejects.toThrow(
			mode === 'leaks job'
				? 'The cancelled job is still running.'
				: 'The same peer must return the response'
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

		await expect(usingProviderFixture(scenario, entry)).rejects.toThrow(
			'Supply a policy effect probe'
		);
	}
);

it.each([
	'blocked',
	'connected',
	'invalid file expectation',
	'success reported for denial'
] as const)(
	'observes listener connections independently of the denied exit status (%s)',
	async (mode) => {
		const base = contractScenario();
		const open = base.provider.create().open;
		let connections = 1;
		const scenario: SandboxProviderTestOptions<undefined> = {
			...base,
			policyEffects: ['denied-network'],
			provider: {
				...base.provider,
				profiles: {
					open: [
						{
							...firstOpenProfile(base.provider),
							exitStatus: 'optional',
							policy: {
								...firstOpenProfile(base.provider).policy,
								network: false
							}
						}
					],
					copy: []
				},

				create: () => ({
					...base.provider.create(),
					async open(...arguments_) {
						const backend = await open(...arguments_);

						return {
							...backend,
							profile: arguments_[0].profile,
							exec(request, context) {
								if (
									mode === 'connected' &&
									request.kind === 'argv' &&
									request.executable === 'probe'
								) {
									connections++;
								}

								return backend.exec(request, context);
							}
						};
					}
				})
			},
			async createFixture() {
				const fixture = await base.createFixture();
				const denied = fixture.processes?.[0];

				if (!denied) {
					throw new Error('Missing denied command fixture.');
				}

				return {
					...fixture,
					policy: { ...fixture.policy, network: false },
					policyEffects: {
						'denied-network': () =>
							Promise.resolve({
								permitted: {
									request: { kind: 'argv', executable: 'pwd', args: [] },
									exit: { kind: 'code', code: 0 },
									stdout: Buffer.from('/remote/project\n'),
									stderr: Buffer.alloc(0)
								},
								denied:
									mode === 'success reported for denial'
										? {
												request: { kind: 'argv', executable: 'pwd', args: [] },
												exit: { kind: 'code', code: 0 },
												stdout: Buffer.from('/remote/project\n'),
												stderr: Buffer.alloc(0)
											}
										: denied,
								...(mode === 'invalid file expectation' && {
									file: { path: 'sample', error: 'unsupported-file' as const }
								}),
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

		const result = usingProviderFixture(scenario, entry);

		if (mode === 'connected') {
			await expect(result).rejects.toThrow(
				'The denied process changed the protected resource.'
			);

			return;
		}

		if (mode === 'invalid file expectation') {
			await expect(result).rejects.toThrow(
				'The unsupported-file error applies only to a read of a late special file.'
			);

			return;
		}

		if (mode === 'success reported for denial') {
			await expect(result).rejects.toThrow(/greater than/);

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
					create: () => ({
						...base.provider.create(),
						async open(...arguments_) {
							const backend = await base.provider.create().open(...arguments_);

							return {
								...backend,
								async dispose(context) {
									events.push(
										isPending ? 'disposed while running' : 'disposed'
									);
									await backend.dispose(context);
								}
							};
						}
					})
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
		const rejected = expect(run).rejects.toMatchObject({
			message: 'The provider contract operation exceeded its deadline.',
			cause: { message: 'The cancelled operation stopped.' }
		});

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
			create: () => ({
				...base.provider.create(),
				async open(...arguments_) {
					const backend = await base.provider.create().open(...arguments_);
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
			})
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

	await expect(usingProviderFixture(options, entry)).rejects.toThrow(
		'The disposed allocation still exists.'
	);
	expect(verifyAllocationDisposed.mock.contexts).toMatchObject([
		{ verifyAllocationDisposed }
	]);
});

class UnmarkedOperationError extends Error {
	override readonly name = 'SandboxOperationError';
}

it.each([
	{ kind: 'special', count: 0, succeeds: false },
	{ kind: 'listener', count: 0, succeeds: false },
	{ kind: 'special', count: 1, succeeds: true },
	{ kind: 'listener', count: 1, succeeds: false }
] as const)(
	'verifies the independent control for a late $kind with count $count',
	async ({ kind, count, succeeds }) => {
		const base = contractScenario();
		const options: SandboxProviderTestOptions<undefined> = {
			...base,
			policyEffects: ['late-special-file'],
			provider: {
				...base.provider,
				create: () => ({
					...base.provider.create(),
					async open(...arguments_) {
						const backend = await base.provider.create().open(...arguments_);
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
											kind === 'listener'
												? new UnmarkedOperationError()
												: new SandboxOperationError({ operation: 'readFile' })
										)
								}
							}
						};
					}
				})
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

		const result = usingProviderFixture(options, entry);

		if (succeeds) {
			await result;

			return;
		}

		await expect(result).rejects.toThrow(
			count === 0 ? 'independent control' : /satisfy/i
		);
	}
);

it.each([1, 2])(
	'finishes disposal of allocation %i under its own deadline',
	async (slowAllocation) => {
		vi.useFakeTimers();

		const base = contractScenario();
		const events: string[] = [];
		let opened = 0;
		const options: SandboxProviderTestOptions<undefined> = {
			...base,
			verifyIndependentAllocations: true,
			timeoutMs: 100,
			cleanup: { cancellationGraceMs: 20, disposalTimeoutMs: 200 },
			provider: {
				...base.provider,
				create: () => ({
					...base.provider.create(),
					async open(...arguments_) {
						const backend = await base.provider.create().open(...arguments_);

						if (++opened !== slowAllocation) {
							return backend;
						}

						return {
							...backend,
							async dispose(context) {
								await new Promise<void>((resolve) => setTimeout(resolve, 150));
								await backend.dispose(context);
								events.push('disposed');
							}
						};
					}
				})
			},
			async createFixture() {
				const fixture = await base.createFixture();
				const peerProcess = fixture.processes?.[0];

				if (!peerProcess) {
					throw new Error('Missing fixture process.');
				}

				return {
					...fixture,
					peerProcess,
					verifyAllocationDisposed: fixture.verifyDisposed,
					async cleanup() {
						events.push('cleanup');
						await fixture.cleanup();
					}
				};
			}
		};

		try {
			const entry = providerContractCases(options).find((test) =>
				test.label.startsWith('independent disposal')
			);

			if (!entry) {
				throw new Error('Missing allocation disposal scenario.');
			}

			const outcome = observe(usingProviderFixture(options, entry));

			await vi.advanceTimersByTimeAsync(300);
			expect(await outcome).toStrictEqual({
				kind: 'resolved',
				value: undefined
			});
			expect(events).toStrictEqual(['disposed', 'cleanup']);
		} finally {
			vi.useRealTimers();
		}
	}
);
