import { checkRequirements } from './acquire-options.js';
import { inspectContext } from './context.js';
import type {
	ReviewSnapshot,
	ReviewSnapshotSource,
	SandboxContext,
	SandboxHost,
	SandboxOperationOptions
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import { UnsupportedSandboxCapabilityError } from './errors.js';
import { operationOptions } from './file-input.js';
import {
	rethrowSnapshotError,
	reviewRequirements,
	snapshotSource
} from './review-requirements.js';

/**
Open a fresh read-only copy of the proposed command's workspace. An unavailable
destination rejects acquisition. A review can reuse the returned sandbox until
it closes the snapshot or aborts the supplied signal.
*/
export async function openReviewSnapshot(
	pi: SandboxHost,
	context: SandboxContext,
	source: ReviewSnapshotSource,
	options?: SandboxOperationOptions
): Promise<ReviewSnapshot> {
	inspectContext(context, 'acquire');

	const broker = ensureSandboxService(pi);

	if (broker.openReviewSnapshot === undefined) {
		throw new UnsupportedSandboxCapabilityError({ operation: 'acquire' });
	}

	const snapshot = await broker.openReviewSnapshot(
		context,
		snapshotSource(source),
		operationOptions(options, 'acquire')
	);

	try {
		checkRequirements(snapshot.sandbox, reviewRequirements);

		return snapshot;
	} catch (error) {
		rethrowSnapshotError(error, await snapshot.close(), {
			operation: 'dispose',
			providerId: snapshot.sandbox.providerId,
			backendId: snapshot.sandbox.backendId
		});
	}
}
