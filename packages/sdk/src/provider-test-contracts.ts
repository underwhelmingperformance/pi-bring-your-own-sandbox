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
	SandboxCleanupBudgets,
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
Restrictions with independent checks in the public provider suite.
*/
export type SandboxPolicyScenario =
	| 'read-only'
	| 'protected-path'
	| 'protected-alias'
	| 'late-special-file'
	| 'denied-network';

/**
Independent observations of a protected object or a controlled listener.
*/
type SandboxPolicyEvidence =
	| {
			readonly kind: 'file';
			readonly content: Uint8Array;
			readonly mode: number;
			readonly links: number;
	  }
	| { readonly kind: 'absent' }
	| {
			readonly kind: 'special';
			readonly bytesReceived: number;
			readonly mode: number;
			readonly links: number;
	  }
	| { readonly kind: 'listener'; readonly connections: number };

/**
Target commands and an independent observer for one policy restriction.
*/
interface SandboxPolicyProbe {
	readonly permitted: SandboxProcessProbe;
	readonly denied: SandboxProcessProbe;
	readonly observe: () => Promise<SandboxPolicyEvidence>;
	/**
	Supply the target path and expected error when the backend offers the corresponding file operation. Use `unsupported-file` for a read that fails because of the special file type.
	*/
	readonly file?: {
		readonly path: string;
		readonly error: 'absent' | 'denied' | 'unsupported-file';
	};
}

/**
An isolated test workspace and provider-specific probes. The suite creates a
fresh fixture for every test. Seed target files before returning this value.
*/
export interface SandboxProviderTestFixture {
	/**
	Prepare the restricted resource after opening, and inspect it independently of the backend.
	*/
	readonly policyEffects?: Partial<
		Readonly<
			Record<
				SandboxPolicyScenario,
				(backend: SandboxBackend) => Promise<SandboxPolicyProbe>
			>
		>
	>;

	/**
	A seeded regular file seen from the source workspace and through a target
	process. Replace the source by rename so a stale open inode cannot pass.
	*/
	readonly visibility?: {
		/**
		Target path of the seeded regular file, relative to the workspace or absolute.
		*/
		readonly targetPath: string;
		/**
		An absent target file in an existing searchable directory. Choose a
		basename without glob metacharacters that the ignore rules include.
		Supply this path to test whether find observes a file created by writeFile.
		*/
		readonly findTarget?: string;
		/**
		Read complete bytes independently from the source workspace.
		*/
		readonly readSource: () => Promise<Uint8Array>;
		/**
		Replace the source file by atomic rename.
		*/
		readonly replaceSource: (bytes: Uint8Array) => Promise<void>;
		/**
		A successful process that writes only the complete target file to stdout.
		*/
		readonly readTarget: ProcessRequest;
		/**
		Poll for the complete replacement in a fresh process. Emit one line per
		read with tab-separated start offset, completion offset and base64
		contents. Both offsets are milliseconds from the start of polling.
		Exit after a complete read or a stale read whose start offset exceeds
		the supplied limit.
		*/
		readonly pollHostReplacement?: (
			bytes: Uint8Array,
			staleReadLimitMs: number
		) => ProcessRequest;
		/**
		A successful process that replaces the target file with the supplied bytes.
		*/
		readonly writeTarget: (bytes: Uint8Array) => ProcessRequest;
		/**
		Prepare an editor save in a temporary file and rename it over the seeded
		file in a second process. The suite replaces the source between commands.
		*/
		readonly stageSave?: (bytes: Uint8Array) => {
			readonly prepare: ProcessRequest;
			readonly commit: ProcessRequest;
		};
		/**
		Create another hard link to the current source file. The returned observer
		reads that link independently before and after the shared editor save.
		Include extended attributes when the filesystem supports them.
		*/
		readonly linkSource?: () => Promise<
			() => Promise<{
				readonly identity: string;
				readonly content: Uint8Array;
				readonly mode: number;
				readonly uid: number;
				readonly gid: number;
				readonly links: number;
				readonly xattrs?: Readonly<Record<string, Uint8Array>>;
			}>
		>;
		/**
		Write the bytes and emit "ready" on stdout. Wait until the same path
		contains the complete replacement, then emit it and exit. Required for
		writable sharing.
		*/
		readonly waitForReplacement?: (
			bytes: Uint8Array,
			replacement: Uint8Array
		) => ProcessRequest;
	};

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
		Complete expected directory metadata. The suite calls a supplied callback
		after stat. Observe the target independently of the backend under test.
		*/
		readonly stat: FileStat | (() => Promise<FileStat>);
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
	A repeatable process on a second allocation from the same source. Required
	for the independent disposal scenario.
	*/
	readonly peerProcess?: SandboxProcessProbe;

	/**
	A peer that emits its ready marker, waits for release, then emits exactly
	the supplied bytes and exits successfully. Release the peer independently
	of the backend under test.
	*/
	readonly concurrentJob?: {
		readonly request: ProcessRequest;
		readonly ready: Uint8Array;
		readonly release: (
			bytes: Uint8Array,
			context: SandboxOperationContext
		) => Promise<void>;
	};
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
		Independently verify termination within the backend's advertised scope.
		Required for `process-group` and `workload`; unused for `none`.
		*/
		readonly verifyStopped?: () => Promise<void>;
		/**
		Successful operation on the same allocation after confirmed termination.
		*/
		readonly after?: SandboxProcessProbe;
	};
	/**
	Independent negative tests for every requested restrictive policy. Required
	for read-only, workspace-only, system-read-only or denied-network scenarios. Assert denied
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
	Check that the first allocation has released its resources while its peer
	remains open. Required for the independent allocation scenario.
	*/
	readonly verifyAllocationDisposed?: (
		backend: SandboxBackend
	) => Promise<void>;
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
	Register one separately reported test for each selected policy restriction.
	*/
	readonly policyEffects?: readonly SandboxPolicyScenario[];

	/**
	Cancel one job while a peer on the same allocation waits for a response.
	*/
	readonly verifyConcurrentCancellation?: boolean;

	/**
	Open two allocations from the same source and verify the second one before
	and after disposing the first.
	*/
	readonly verifyIndependentAllocations?: boolean;

	/**
	Run another process after independently confirming cancellation. Supply
	`cancellation.after` for this scenario.
	*/
	readonly verifyRecoveryAfterCancellation?: boolean;

	/**
	Select the shared or copied visibility tests for this scenario. Writable
	workspaces also exercise changes from the target.
	*/
	readonly workspaceVisibility?: 'shared' | 'copied';

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
	Deadline for opening, each test case and fixture cleanup, in milliseconds.
	Each stage receives a separate deadline. Defaults to 10,000.
	*/
	readonly timeoutMs?: number;
	/**
	Cancellation grace and disposal timeout in milliseconds, independent of stage
	deadlines. Defaults to 5,000 and 10,000; each must be an integer from 1 to 300,000.
	*/
	readonly cleanup?: Partial<SandboxCleanupBudgets>;
}
