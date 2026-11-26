import type {
	ProcessResult,
	SandboxClient,
	SandboxContext
} from 'pi-bring-your-own-sandbox/api';

/**
Runs the selected target's `pwd` executable to inspect its working directory.
Pass Pi's per-tool signal so acquisition and execution can both be cancelled.
The injected client lets tests substitute SDK behaviour without selecting a
different provider in consumer code.
*/
export async function inspectWorkspace(
	client: Pick<SandboxClient, 'get'>,
	context: SandboxContext,
	signal?: AbortSignal
): Promise<ProcessResult> {
	const options = signal === undefined ? {} : { signal };
	const sandbox = await client.get(context, options);

	return sandbox.exec({ kind: 'argv', executable: 'pwd', args: [] }, options);
}
