import type {
	ProcessEnvironment,
	ProcessExit,
	ProcessOutput,
	RecoveryDescriptor,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/api';

/**
Local Docker daemon and CLI used by the reference provider.
*/
export interface DockerConfig {
	/**
	Absolute Unix socket path. Remote daemons cannot copy the host workspace.
	*/
	readonly socketPath: string;
	/**
	Absolute path of the Docker CLI executable.
	*/
	readonly executable: string;
}

/**
A CLI deadline that can change when foreground cancellation begins.
*/
export interface DockerOperationContext extends SandboxOperationContext {
	/**
	Refresh the CLI deadline when this signal aborts, without cancelling the
	management command.
	*/
	readonly deadlineChanged?: AbortSignal;
}

/**
A management command or attached job, without a host shell.
*/
export interface DockerCommand {
	/**
	Docker subcommand and literal arguments, following the fixed daemon option.
	*/
	readonly args: readonly string[];
	/**
	Deadline for the local CLI. The provider handles target cancellation.
	*/
	readonly context: DockerOperationContext;
	/**
	SDK operation associated with a transport failure.
	*/
	readonly operation: 'open' | 'exec' | 'dispose';
	/**
	Recovery metadata for resources that may remain after a transport failure.
	*/
	readonly recovery: RecoveryDescriptor;
	/**
	Stream job bytes synchronously; omit this callback to capture management output.
	*/
	readonly onOutput?: (output: ProcessOutput) => void;
}

/**
Local CLI completion. Non-zero statuses require interpretation by the caller.
*/
export interface DockerCommandResult {
	/**
	CLI exit status, independent of the container's inspected exit status.
	*/
	readonly status: number;
	/**
	Captured management stdout. Attached job output is streamed and not retained.
	*/
	readonly stdout: Uint8Array;
	/**
	Captured management stderr. Attached job output is streamed and not retained.
	*/
	readonly stderr: Uint8Array;
}

/**
Injectable transport for Docker management commands and attached output.
*/
export interface DockerClient {
	/**
	Run without a host shell and reject a deadline or lost CLI transport.
	*/
	readonly command: (command: DockerCommand) => Promise<DockerCommandResult>;
}

/**
Literal child invocation passed to the isolated launcher as JSON.
*/
export interface TargetInvocation {
	/**
	Target executable, resolved by Node using the child's environment.
	*/
	readonly executable: string;
	/**
	Arguments passed directly to the target executable.
	*/
	readonly args: readonly string[];
	/**
	Absolute target working directory.
	*/
	readonly cwd: string;
	/**
	Overrides applied only after the launcher drops child privileges.
	*/
	readonly env: ProcessEnvironment;
}

/**
Launcher messages, separated from bytes emitted by the child process.
*/
export type LaunchFrame =
	| { readonly kind: 'stdout' | 'stderr'; readonly data: string }
	| { readonly kind: 'exited'; readonly exit: ProcessExit }
	| { readonly kind: 'not-found' | 'permission-denied' | 'start-failed' };
