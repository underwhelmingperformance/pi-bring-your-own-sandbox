import type {
	ProcessResult,
	SandboxClient,
	SandboxContext,
	SandboxHost
} from '../api.js';

export async function inspectWorkspace(
	client: SandboxClient,
	pi: SandboxHost,
	context: SandboxContext,
	signal: AbortSignal
): Promise<ProcessResult> {
	const sandbox = await client.getSandbox(pi, context, { signal });

	return sandbox.exec(
		{ kind: 'argv', executable: 'pwd', args: [] },
		{ signal }
	);
}
