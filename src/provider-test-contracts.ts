import type {
	DirectoryEntry,
	FileStat,
	FindRequest,
	FindResult,
	GrepRequest,
	GrepResult,
	ProcessExit,
	ProcessRequest,
	SandboxBackend,
	SandboxCapabilities,
	SandboxOperationContext,
	SandboxPolicy,
	SandboxProvider,
	ShellDialect
} from './contracts.js';

/**
A target program with deterministic output and exit status. Use argv probes
with arguments that would change meaning if interpreted by a shell.
*/
export interface SandboxProcessProbe {
	/**
	Target invocation, including any environment overrides and working directory.
	*/
	readonly request: ProcessRequest;
	/**
	Expected foreground exit, including a non-zero code when testing failures.
	*/
	readonly exit: ProcessExit;
	/**
	Complete stdout bytes in delivery order.
	*/
	readonly stdout: Uint8Array;
	/**
	Complete stderr bytes in delivery order.
	*/
	readonly stderr: Uint8Array;
}

/**
An isolated test workspace and provider-specific probes. The suite creates a
fresh fixture for every test. Seed target files before returning this value.
*/
export interface SandboxProviderTestFixture {
	/**
	Unknown configuration passed through the provider's validator.
	*/
	readonly configuration: unknown;
	/**
	Absolute host workspace passed to opening, independent of target paths.
	*/
	readonly hostWorkspace: string;
	/**
	Required policy for this test scenario.
	*/
	readonly policy: SandboxPolicy;
	/**
	Required when argv is supported. Include cwd, environment and non-zero
	exits. Optional-status providers can include unavailable exit details.
	*/
	readonly processes?: readonly SandboxProcessProbe[];
	/**
	A probe for each shell dialect selected in the suite's capabilities.
	*/
	readonly shells?: Partial<
		Readonly<Record<ShellDialect, SandboxProcessProbe>>
	>;
	/**
	Seeded regular file, required when testing `files.read`.
	*/
	readonly read?: {
		/**
		Target path of the seeded regular file.
		*/
		readonly path: string;
		/**
		Complete file contents before the test starts.
		*/
		readonly bytes: Uint8Array;
		/**
		Target path that does not exist.
		*/
		readonly missingPath: string;
	};
	/**
	Mutation targets, required when testing `files.write`. For read-write
	scenarios, both paths must be absent and the file must be within the directory.
	*/
	readonly write?: {
		/**
		Target directory to create, including missing parents.
		*/
		readonly directory: string;
		/**
		Target file to replace, or attempt to replace in a read-only scenario.
		*/
		readonly path: string;
		/**
		Read independently of the backend's file methods to verify target effects.
		*/
		readonly read: () => Promise<Uint8Array>;
	};
	/**
	Seeded directory, required when testing `files.list`. Order is ignored.
	*/
	readonly list?: {
		/**
		Target path of the seeded directory.
		*/
		readonly path: string;
		/**
		Complete expected metadata of that directory.
		*/
		readonly stat: FileStat;
		/**
		Immediate children before the test starts.
		*/
		readonly entries: readonly DirectoryEntry[];
	};
	/**
	Queries and exact results under the provider's documented glob rules.
	*/
	readonly find?: readonly {
		/**
		Target root, glob and result limit to exercise.
		*/
		readonly request: FindRequest;
		/**
		Complete expected result, including provider-defined order.
		*/
		readonly result: FindResult;
	}[];
	/**
	Queries and exact results under the provider's documented regex rules.
	*/
	readonly grep?: readonly {
		/**
		Target root, pattern, matching options, context and result limit.
		*/
		readonly request: GrepRequest;
		/**
		Complete expected result, including provider-defined order.
		*/
		readonly result: GrepResult;
	}[];
	/**
	A long-running foreground job, including a descendant when supported.
	*/
	readonly cancellation: {
		/**
		Target program that remains active until cancelled.
		*/
		readonly request: ProcessRequest;
		/**
		Non-empty stdout marker emitted after the job and descendants start.
		*/
		readonly ready: Uint8Array;
		/**
		Independently verify that the job and descendants have stopped.
		*/
		readonly verifyStopped: () => Promise<void>;
	};
	/**
	Independent negative tests for every requested restrictive policy. Required
	for read-only, workspace-only or denied-network scenarios. Assert denied
	effects, including through exec; checking backend metadata is insufficient.
	*/
	readonly verifyPolicy?: (
		backend: SandboxBackend,
		context: SandboxOperationContext
	) => Promise<void>;
	/**
	Independently verify resource release after backend disposal resolves.
	*/
	readonly verifyDisposed: () => Promise<void>;
	/**
	Always release fixture resources, including allocations left by failed
	opening or disposal. This callback must also work before opening succeeds.
	*/
	readonly cleanup: () => Promise<void>;
}

/**
One provider scenario for the reusable Vitest suite. Register separate scenarios
for different policy modes and backend capability subsets.
@typeParam Config - Validated provider configuration.
*/
export interface SandboxProviderTestOptions<Config> {
	/**
	Vitest suite description identifying this scenario.
	*/
	readonly label: string;
	/**
	Provider declaration under test; Pi registration is not required.
	*/
	readonly provider: SandboxProvider<Config>;
	/**
	Operation groups and shells to test; defaults to the provider declaration.
	*/
	readonly capabilities?: SandboxCapabilities;
	/**
	Prepare fresh resources and target probes for each case. Clean up partial
	setup within this callback if setup fails before returning a fixture.
	*/
	readonly createFixture: () => Promise<SandboxProviderTestFixture>;
	/**
	Deadline for opening, each test case, disposal and cleanup, in milliseconds.
	Each stage receives a separate deadline. Defaults to 10,000.
	*/
	readonly timeoutMs?: number;
}
