import type { TSchema } from 'typebox';

import {
	processResultSchema,
	sandboxHandleSchema
} from './consumer-wire-schemas.js';
import type {
	Sandbox,
	SandboxCopy,
	SandboxFiles,
	SandboxSearch
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	isSandboxCloseReport,
	SandboxOperationError
} from './errors.js';
import {
	accessMode,
	findRequest,
	grepRequest,
	readOptions,
	requirePath
} from './file-input.js';
import {
	isDirectoryEntries,
	isFileStat,
	isFindResult,
	isGrepResult
} from './file-result.js';
import { profileSchema } from './policy-model.js';
import {
	snapshotProcessOptions,
	snapshotProcessRequest
} from './process-input.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { invalidProtocolServiceReply } from './protocol-envelope.js';
import { projectOffer } from './protocol-schema.js';
import {
	checkDemand,
	sharedFeatureLevel,
	unavailableFeature
} from './protocol-version.js';
import {
	acquireOptionsSchema,
	findRequestSchema,
	grepRequestSchema,
	MAX_CAPTURE_BYTES,
	operationOptionsSchema,
	processOptionsSchema,
	processRequestSchema,
	readOptionsSchema
} from './request-schemas.js';
import { checkedCopy, rethrowCopyError } from './sandbox-copy.js';
import { bytesSchema, checker } from './schemas.js';
import { snapshotProfile } from './validation.js';

const isSandbox = checker(sandboxHandleSchema);
const isProcessResult = checker(processResultSchema);
const isBytes = checker(bytesSchema);
const isProfile = checker(profileSchema);

export function bindSandbox(
	value: unknown,
	local: ProtocolIdentity,
	peer: ProtocolIdentity
): Sandbox {
	if (!isSandbox(value)) {
		throw invalidProtocolServiceReply(peer);
	}

	const source = value;
	const level = sharedFeatureLevel(local, peer);
	const profile = projectOffer(profileSchema, source.profile, level);

	if (!isProfile(profile)) {
		throw unavailableFeature('sandbox result', level, peer);
	}

	const demand = (schema: TSchema, input: unknown, operation: string) => {
		checkDemand(
			schema,
			input === undefined ? {} : input,
			local,
			peer,
			operation
		);
	};

	const invalid = () => invalidProtocolServiceReply(peer);
	const invokeVoid = async (invoke: () => Promise<unknown>) => {
		if ((await invoke()) !== undefined) {
			throw invalid();
		}
	};

	const flavor = source.workspace.pathFlavor;
	const files: SandboxFiles = {
		async readFile(filename, options) {
			const checked = readOptions(options);

			demand(readOptionsSchema, checked, 'readFile');

			const bytes: unknown = await source.files.readFile(
				requirePath(filename, 'readFile'),
				checked
			);

			if (!isBytes(bytes)) {
				throw invalid();
			}

			const { maxBytes } = checked;

			if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
				throw new SandboxOperationError({
					operation: 'readFile',
					providerId: source.providerId,
					backendId: source.backendId,
					detail: { kind: 'read-limit', maxBytes }
				});
			}

			return new Uint8Array(bytes);
		},
		async writeFile(filename, bytes, options) {
			demand(operationOptionsSchema, options, 'writeFile');

			if (!isBytes(bytes)) {
				throw new InvalidSandboxRequestError({ operation: 'writeFile' });
			}

			await invokeVoid(() =>
				source.files.writeFile(
					requirePath(filename, 'writeFile'),
					new Uint8Array(bytes),
					options
				)
			);
		},
		async access(filename, mode, options) {
			demand(operationOptionsSchema, options, 'access');

			await invokeVoid(() =>
				source.files.access(
					requirePath(filename, 'access'),
					accessMode(mode),
					options
				)
			);
		},
		async mkdir(filename, options) {
			demand(operationOptionsSchema, options, 'mkdir');

			await invokeVoid(() =>
				source.files.mkdir(requirePath(filename, 'mkdir'), options)
			);
		},

		async stat(filename, options) {
			demand(operationOptionsSchema, options, 'stat');

			const result: unknown = await source.files.stat(
				requirePath(filename, 'stat'),
				options
			);

			if (!isFileStat(result)) {
				throw invalid();
			}

			return result;
		},
		async listDirectory(filename, options) {
			demand(operationOptionsSchema, options, 'listDirectory');

			const entries: unknown = await source.files.listDirectory(
				requirePath(filename, 'listDirectory'),
				options
			);

			if (!isDirectoryEntries(entries, flavor)) {
				throw invalid();
			}

			return entries;
		}
	};
	const search: SandboxSearch = {
		async find(input, options) {
			demand(findRequestSchema, input, 'find');
			demand(operationOptionsSchema, options, 'find');

			const request = findRequest(input);
			const result: unknown = await source.search.find(request, options);

			if (
				!isFindResult(
					result,
					flavor,
					request.limit ?? findRequestSchema.properties.limit.default
				)
			) {
				throw invalid();
			}

			return result;
		},
		async grep(input, options) {
			demand(grepRequestSchema, input, 'grep');
			demand(operationOptionsSchema, options, 'grep');

			const request = grepRequest(input);
			const result: unknown = await source.search.grep(request, options);

			if (
				!isGrepResult(
					result,
					flavor,
					request.limit ?? grepRequestSchema.properties.limit.default,
					request.context ?? grepRequestSchema.properties.context.default
				)
			) {
				throw invalid();
			}

			return result;
		}
	};

	return Object.freeze<Sandbox>({
		providerId: source.providerId,
		backendId: source.backendId,
		generationId: source.generationId,
		workspace: Object.freeze({
			root: source.workspace.root,
			pathFlavor: source.workspace.pathFlavor,
			relationship: source.workspace.relationship,
			...(source.workspace.home !== undefined && {
				home: source.workspace.home
			}),
			...(source.workspace.hostUserDataRoot !== undefined && {
				hostUserDataRoot: source.workspace.hostUserDataRoot
			}),
			...(source.workspace.defaultShell !== undefined && {
				defaultShell: source.workspace.defaultShell
			})
		}),
		profile: snapshotProfile(profile),
		...(source.grantedPaths !== undefined && {
			grantedPaths: source.grantedPaths
		}),
		files: Object.freeze(files),
		search: Object.freeze(search),
		async exec(input, settings) {
			const request = snapshotProcessRequest(input);
			const options = snapshotProcessOptions(settings);

			demand(processRequestSchema, request, 'exec');
			demand(processOptionsSchema, options, 'exec');

			const result: unknown = await source.exec(request, options);

			if (
				!isProcessResult(result) ||
				result.stdout.byteLength + result.stderr.byteLength >
					(options.maxCaptureBytes ?? MAX_CAPTURE_BYTES) ||
				(profile.exitStatus === 'guaranteed' &&
					result.exit.kind === 'unavailable')
			) {
				throw invalid();
			}

			return Object.freeze({
				exit: result.exit,
				stdout: new Uint8Array(result.stdout),
				stderr: new Uint8Array(result.stderr),
				omittedBytes: Object.freeze({ ...result.omittedBytes })
			});
		},
		async copy(options) {
			demand(acquireOptionsSchema, options, 'copy');

			const copy = await checkedCopy(
				await source.copy(options),
				options ?? {},
				local.extensionSource
			);

			return bindOwnedCopy(copy, local, peer);
		}
	});
}

export async function bindOwnedCopy(
	copy: SandboxCopy,
	local: ProtocolIdentity,
	peer: ProtocolIdentity
): Promise<SandboxCopy> {
	let sandbox: Sandbox;

	try {
		sandbox = bindSandbox(copy.sandbox, local, peer);
	} catch (error) {
		return rethrowCopyError(error, () => copy.close(), {
			operation: 'dispose',
			providerId: copy.sandbox.providerId,
			backendId: copy.sandbox.backendId
		});
	}

	return Object.freeze<SandboxCopy>({
		sandbox,
		async close() {
			const report: unknown = await copy.close();

			if (!isSandboxCloseReport(report)) {
				throw invalidProtocolServiceReply(peer);
			}

			return report;
		}
	});
}
