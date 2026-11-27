import type {
	CancellationReason,
	OperationCompletion,
	RecoveryDescriptor,
	SandboxCloseReport,
	SandboxErrorContext,
	SandboxErrorInfo,
	SandboxErrorName,
	SandboxOperation
} from './contracts.js';
import { cleanDisplayText } from './display-text.js';
import { closeReportSchema, errorSchema } from './error-schema.js';
import { checker } from './schemas.js';

/**
Shared context for concrete sandbox errors. Construct a specific subclass.
Use the structural guard when errors can come from another installed SDK
copy.
*/
abstract class SandboxError<Name extends string = string> extends Error {
	/**
	Stable class identity, preserved across SDK copies and minification.
	*/
	override readonly name: Name;

	/**
	The operation that failed.
	*/
	readonly operation: SandboxOperation;

	/**
	The source of invalid extension configuration.
	*/
	declare readonly extensionSource?: string;
	declare readonly detail?: NonNullable<SandboxErrorContext['detail']>;

	/**
	Provider identity, when known before the failure.
	*/
	declare readonly providerId?: string;

	/**
	Backend identity, when allocation progressed far enough.
	*/
	declare readonly backendId?: string;

	/**
	Copied, non-secret recovery metadata for resources that may still exist.
	*/
	declare readonly recovery?: RecoveryDescriptor;

	protected constructor(
		name: Name,
		message: string,
		context: SandboxErrorContext,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = name;
		this.operation = context.operation;

		if (context.extensionSource !== undefined) {
			this.extensionSource = context.extensionSource;
		}

		if (context.detail !== undefined) {
			this.detail = Object.freeze({ ...context.detail });
		}

		if (context.providerId !== undefined) {
			this.providerId = context.providerId;
		}

		if (context.backendId !== undefined) {
			this.backendId = context.backendId;
		}

		if (context.recovery !== undefined) {
			this.recovery = Object.freeze({ ...context.recovery });
		}
	}
}

/**
The broker could not initialise. Reload extensions before acquiring another
handle.
*/
export class SandboxInitialisationError extends SandboxError<'SandboxInitialisationError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxInitialisationError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			SandboxInitialisationError.errorName,
			'The sandbox service could not initialise. Reload the extensions.',
			context,
			options
		);
	}
}

/**
Discovery found multiple brokers in one Pi runtime. Remove the conflicting
extension before retrying.
*/
export class DuplicateBrokerError extends SandboxError<'DuplicateBrokerError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'DuplicateBrokerError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			DuplicateBrokerError.errorName,
			'More than one sandbox broker is active. Remove the conflicting extension and reload.',
			context,
			options
		);
	}
}

/**
A peer requires a protocol major or feature level that this exchange cannot use.
*/
export class IncompatibleSandboxProtocolError extends SandboxError<'IncompatibleSandboxProtocolError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'IncompatibleSandboxProtocolError';

	constructor(
		context: SandboxErrorContext & { readonly protocolMessage?: string },
		options?: ErrorOptions
	) {
		super(
			IncompatibleSandboxProtocolError.errorName,
			context.protocolMessage ??
				'The sandbox service uses an incompatible protocol. Update the extensions together.',
			context,
			options
		);
	}
}

/**
Provider or backend metadata violates the advertised protocol. Consumers
must not use the declaration.
*/
export class InvalidSandboxDeclarationError extends SandboxError<'InvalidSandboxDeclarationError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'InvalidSandboxDeclarationError';

	constructor(
		context: SandboxErrorContext & { readonly protocolMessage?: string },
		options?: ErrorOptions
	) {
		super(
			InvalidSandboxDeclarationError.errorName,
			context.protocolMessage ??
				'The sandbox provider or service declaration is invalid. Check the extension implementation.',
			context,
			options
		);
	}
}

/**
Settings could not be read or validated. The selected provider remains
selected when configuration fails.
*/
export class InvalidSandboxConfigError extends SandboxError<'InvalidSandboxConfigError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'InvalidSandboxConfigError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			InvalidSandboxConfigError.errorName,
			'Sandbox settings are invalid. Check the extension configuration.',
			context,
			options
		);
	}
}

/**
An operation input violates the SDK contract. Framework input validation
raises this before provider invocation.
*/
export class InvalidSandboxRequestError extends SandboxError<'InvalidSandboxRequestError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'InvalidSandboxRequestError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			InvalidSandboxRequestError.errorName,
			'The sandbox request is invalid. Check the operation inputs.',
			context,
			options
		);
	}
}

/**
The configured provider is absent. Installing it or changing the user
configuration permits acquisition.
*/
export class ProviderNotFoundError extends SandboxError<'ProviderNotFoundError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'ProviderNotFoundError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			ProviderNotFoundError.errorName,
			'The selected sandbox provider is not installed.',
			context,
			options
		);
	}
}

/**
The selected provider declared that it is unavailable before configuration.
*/
export class SandboxProviderUnavailableError extends SandboxError<'SandboxProviderUnavailableError'> {
	static readonly errorName = 'SandboxProviderUnavailableError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		const detail = context.detail;

		super(
			SandboxProviderUnavailableError.errorName,
			'The selected sandbox provider is unavailable on this platform.',
			detail?.kind === 'provider-unavailable'
				? {
						...context,
						detail: { ...detail, reason: Object.freeze({ ...detail.reason }) }
					}
				: context,
			options
		);
	}
}

/**
Multiple extensions activated sandbox providers for one runtime.
*/
export class ConflictingSandboxProviderError extends SandboxError<'ConflictingSandboxProviderError'> {
	/**
 Stable identity recognised across independently installed SDK copies.
 */
	static readonly errorName = 'ConflictingSandboxProviderError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			ConflictingSandboxProviderError.errorName,
			'More than one sandbox provider is active. Disable the conflicting provider and reload.',
			context,
			options
		);
	}
}

/**
Multiple extensions configured the same execution setting.
*/
export class ConflictingSandboxConfigError extends SandboxError<'ConflictingSandboxConfigError'> {
	/**
 Stable identity recognised across independently installed SDK copies.
 */
	static readonly errorName = 'ConflictingSandboxConfigError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			ConflictingSandboxConfigError.errorName,
			'More than one extension configured the same execution setting.',
			context,
			options
		);
	}
}

/**
Provider discovery found a repeated ID or an ID reserved by the built-in registry.
Selection cannot proceed.
*/
export class DuplicateProviderError extends SandboxError<'DuplicateProviderError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'DuplicateProviderError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			DuplicateProviderError.errorName,
			'A sandbox provider ID is reserved or registered more than once.',
			context,
			options
		);
	}
}

/**
The selected backend lacks an operation or shell required by the caller.
*/
export class UnsupportedSandboxCapabilityError extends SandboxError<'UnsupportedSandboxCapabilityError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'UnsupportedSandboxCapabilityError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			UnsupportedSandboxCapabilityError.errorName,
			'The selected sandbox does not support the required capability.',
			context,
			options
		);
	}
}

/**
The selected provider cannot satisfy the requested protection requirements.
Acquisition must fail.
*/
export class UnsupportedSandboxPolicyError extends SandboxError<'UnsupportedSandboxPolicyError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'UnsupportedSandboxPolicyError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			UnsupportedSandboxPolicyError.errorName,
			'The selected sandbox cannot satisfy the requested policy.',
			context,
			options
		);
	}
}

/**
The selected provider failed while opening a backend. Acquisition does not
switch providers.
*/
export class SandboxStartupError extends SandboxError<'SandboxStartupError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxStartupError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			SandboxStartupError.errorName,
			'The selected sandbox could not start. Check the provider configuration.',
			context,
			options
		);
	}
}

/**
A cached facade belongs to an inactive runtime or generation. Acquire a new
facade before further operations.
*/
export class StaleSandboxHandleError extends SandboxError<'StaleSandboxHandleError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'StaleSandboxHandleError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			StaleSandboxHandleError.errorName,
			'This sandbox handle belongs to an inactive Pi runtime. Acquire a new handle.',
			context,
			options
		);
	}
}

/**
The broker has begun shutdown. It rejects new operations in the closing
generation.
*/
export class SandboxSessionClosingError extends SandboxError<'SandboxSessionClosingError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxSessionClosingError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			SandboxSessionClosingError.errorName,
			'The sandbox session is closing. New operations are unavailable.',
			context,
			options
		);
	}
}

/**
The target denied an operation because of filesystem permissions or sandbox
policy.
*/
export class SandboxPermissionDeniedError extends SandboxError<'SandboxPermissionDeniedError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxPermissionDeniedError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			SandboxPermissionDeniedError.errorName,
			context.detail?.kind === 'request' &&
				context.detail.field === 'allowEscalation'
				? 'Sandbox escalation is disabled by allowEscalation.'
				: 'The sandbox denied access to the requested resource.',
			context,
			options
		);
	}
}

/**
A target path or executable does not exist. The path belongs to the sandbox
filesystem.
*/
export class SandboxPathNotFoundError extends SandboxError<'SandboxPathNotFoundError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxPathNotFoundError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			SandboxPathNotFoundError.errorName,
			'The requested sandbox path or executable does not exist.',
			context,
			options
		);
	}
}

/**
A target operation failed. Inspect the diagnostic cause without printing it
automatically.
*/
export class SandboxOperationError extends SandboxError<'SandboxOperationError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxOperationError';

	constructor(context: SandboxErrorContext, options?: ErrorOptions) {
		super(
			SandboxOperationError.errorName,
			'The sandbox operation failed.',
			context,
			options
		);
	}
}

/**
Resource cleanup could not be confirmed. Use the recovery descriptor to
check for remaining resources.
*/
export class SandboxCleanupError extends SandboxError<'SandboxCleanupError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxCleanupError';

	declare readonly closeReport?: SandboxCloseReport;

	constructor(
		context: SandboxErrorContext & {
			readonly closeReport?: SandboxCloseReport;
		},
		options?: ErrorOptions
	) {
		super(
			SandboxCleanupError.errorName,
			'Sandbox cleanup could not be confirmed. Check the recovery descriptor.',
			context,
			options
		);

		if (context.closeReport !== undefined) {
			this.closeReport = snapshotCloseReport(context.closeReport);
		}
	}
}

/**
The caller or session shutdown cancelled an operation. Check completion
before assuming that effects stopped.
*/
export class SandboxCancelledError extends SandboxError<'SandboxCancelledError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxCancelledError';

	/**
	The first cancellation source observed by the SDK.
	*/
	readonly reason: 'caller' | 'shutdown';

	/**
	Whether the operation started and its effects are known to have stopped.
	*/
	readonly completion: OperationCompletion;

	constructor(
		context: SandboxErrorContext & {
			readonly reason: 'caller' | 'shutdown';
			readonly completion: OperationCompletion;
		},
		options?: ErrorOptions
	) {
		super(
			SandboxCancelledError.errorName,
			'The sandbox operation was cancelled.',
			context,
			options
		);
		this.reason = context.reason;
		this.completion = context.completion;
	}
}

/**
An operation exceeded its deadline. Completion distinguishes an acknowledged
stop from an unknown outcome.
*/
export class SandboxTimeoutError extends SandboxError<'SandboxTimeoutError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxTimeoutError';

	/**
	The cancellation source for this error.
	*/
	readonly reason = 'deadline';

	/**
	Whether the provider confirmed that the operation can have no later
	effects.
	*/
	readonly completion: OperationCompletion;

	constructor(
		context: SandboxErrorContext & { readonly completion: OperationCompletion },
		options?: ErrorOptions
	) {
		super(
			SandboxTimeoutError.errorName,
			'The sandbox operation exceeded its deadline.',
			context,
			options
		);
		this.completion = context.completion;
	}
}

/**
The synchronous output callback failed. Execution was cancelled and
completion reports the termination acknowledgement.
*/
export class SandboxOutputCallbackError extends SandboxError<'SandboxOutputCallbackError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxOutputCallbackError';

	/**
	The cancellation source for this error.
	*/
	readonly reason = 'output';

	/**
	Whether the provider confirmed that the operation can have no later
	effects.
	*/
	readonly completion: OperationCompletion;

	constructor(
		context: SandboxErrorContext & { readonly completion: OperationCompletion },
		options?: ErrorOptions
	) {
		super(
			SandboxOutputCallbackError.errorName,
			'The sandbox output callback failed.',
			context,
			options
		);
		this.completion = context.completion;
	}
}

/**
Communication failed and operation completion is unknown. The backend is
unhealthy and the operation must not be replayed automatically.
*/
export class SandboxTransportError extends SandboxError<'SandboxTransportError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'SandboxTransportError';

	/**
	The operation may still produce effects in the target.
	*/
	readonly completion = 'unknown';

	/**
	The first cancellation source, if cancellation preceded the failure.
	*/
	declare readonly reason?: CancellationReason;

	constructor(
		context: SandboxErrorContext & { readonly reason?: CancellationReason },
		options?: ErrorOptions
	) {
		super(
			SandboxTransportError.errorName,
			'The sandbox transport failed. Operation completion is unknown.',
			context,
			options
		);

		if (context.reason !== undefined) {
			this.reason = context.reason;
		}
	}
}

/**
The provider did not confirm termination within the cancellation grace
period. The backend is unhealthy.
*/
export class UnconfirmedSandboxTerminationError extends SandboxError<'UnconfirmedSandboxTerminationError'> {
	/**
	Stable identity used by the structural guard across SDK copies.
	*/
	static readonly errorName = 'UnconfirmedSandboxTerminationError';

	/**
	The operation may still produce effects in the target.
	*/
	readonly completion = 'unknown';

	/**
	The first cancellation source, if cancellation preceded the failure.
	*/
	declare readonly reason?: CancellationReason;

	constructor(
		context: SandboxErrorContext & { readonly reason?: CancellationReason },
		options?: ErrorOptions
	) {
		super(
			UnconfirmedSandboxTerminationError.errorName,
			'The sandbox did not confirm termination. Operation completion is unknown.',
			context,
			options
		);

		if (context.reason !== undefined) {
			this.reason = context.reason;
		}
	}
}

/**
Recreates a compatible structural error with this SDK's concrete
constructor.
*/
export function rehydrateSandboxError(
	error: SandboxErrorInfo,
	options?: ErrorOptions,
	override?: SandboxErrorContext
): SandboxErrorInfo {
	const { operation, providerId, recovery } = override ?? error;
	const extensionSource = override?.extensionSource ?? error.extensionSource;
	const detail = override?.detail ?? error.detail;
	const backendId = override?.backendId ?? error.backendId;
	const context: SandboxErrorContext = {
		operation,
		...(extensionSource !== undefined && { extensionSource }),
		...(detail !== undefined && { detail }),
		...(backendId !== undefined && { backendId }),
		...(providerId !== undefined && { providerId }),
		...(recovery !== undefined && { recovery })
	};

	switch (error.name) {
		case 'SandboxInitialisationError': {
			return new SandboxInitialisationError(context, options);
		}

		case 'DuplicateBrokerError': {
			return new DuplicateBrokerError(context, options);
		}

		case 'IncompatibleSandboxProtocolError': {
			return new IncompatibleSandboxProtocolError(
				{ ...context, protocolMessage: error.message },
				options
			);
		}

		case 'InvalidSandboxDeclarationError': {
			return new InvalidSandboxDeclarationError(
				{
					...context,
					...(error.operation === 'discover' && {
						protocolMessage: cleanDisplayText(error.message)
					})
				},
				options
			);
		}

		case 'InvalidSandboxConfigError': {
			return new InvalidSandboxConfigError(context, options);
		}

		case 'InvalidSandboxRequestError': {
			return new InvalidSandboxRequestError(context, options);
		}

		case 'ProviderNotFoundError': {
			return new ProviderNotFoundError(context, options);
		}

		case 'SandboxProviderUnavailableError': {
			return new SandboxProviderUnavailableError(context, options);
		}

		case 'ConflictingSandboxProviderError': {
			return new ConflictingSandboxProviderError(context, options);
		}

		case 'ConflictingSandboxConfigError': {
			return new ConflictingSandboxConfigError(context, options);
		}

		case 'DuplicateProviderError': {
			return new DuplicateProviderError(context, options);
		}

		case 'UnsupportedSandboxCapabilityError': {
			return new UnsupportedSandboxCapabilityError(context, options);
		}

		case 'UnsupportedSandboxPolicyError': {
			return new UnsupportedSandboxPolicyError(context, options);
		}

		case 'SandboxStartupError': {
			return new SandboxStartupError(context, options);
		}

		case 'StaleSandboxHandleError': {
			return new StaleSandboxHandleError(context, options);
		}

		case 'SandboxSessionClosingError': {
			return new SandboxSessionClosingError(context, options);
		}

		case 'SandboxPermissionDeniedError': {
			return new SandboxPermissionDeniedError(context, options);
		}

		case 'SandboxPathNotFoundError': {
			return new SandboxPathNotFoundError(context, options);
		}

		case 'SandboxOperationError': {
			return new SandboxOperationError(context, options);
		}

		case 'SandboxCleanupError': {
			return new SandboxCleanupError(
				{
					...context,
					...(error.closeReport !== undefined && {
						closeReport: error.closeReport
					})
				},
				options
			);
		}

		case 'SandboxCancelledError': {
			return new SandboxCancelledError(
				{ ...context, reason: error.reason, completion: error.completion },
				options
			);
		}

		case 'SandboxTimeoutError': {
			return new SandboxTimeoutError(
				{ ...context, completion: error.completion },
				options
			);
		}

		case 'SandboxOutputCallbackError': {
			return new SandboxOutputCallbackError(
				{ ...context, completion: error.completion },
				options
			);
		}

		case 'SandboxTransportError': {
			return new SandboxTransportError(
				{
					...context,
					...(error.reason !== undefined && { reason: error.reason })
				},
				options
			);
		}

		case 'UnconfirmedSandboxTerminationError': {
			return new UnconfirmedSandboxTerminationError(
				{
					...context,
					...(error.reason !== undefined && { reason: error.reason })
				},
				options
			);
		}
	}
}

const isError = checker(errorSchema);
const isCloseReportShape = checker(closeReportSchema);

function areCloseReportsAcyclic(
	value: unknown,
	parents = new Set<object>()
): boolean {
	if (typeof value !== 'object' || value === null) {
		return true;
	}

	const failures: unknown = Reflect.get(value, 'failures');

	if (!Array.isArray(failures)) {
		return true;
	}

	if (parents.has(value)) {
		return false;
	}

	parents.add(value);

	const children: readonly unknown[] = failures;
	const isValid = children.every(
		(failure) =>
			typeof failure !== 'object' ||
			failure === null ||
			areCloseReportsAcyclic(Reflect.get(failure, 'closeReport'), parents)
	);

	parents.delete(value);

	return isValid;
}

export function isSandboxCloseReport(
	value: unknown
): value is SandboxCloseReport {
	return areCloseReportsAcyclic(value) && isCloseReportShape(value);
}

function snapshotCloseReport(report: SandboxCloseReport): SandboxCloseReport {
	if (!isSandboxCloseReport(report)) {
		throw new InvalidSandboxDeclarationError({ operation: 'dispose' });
	}

	return Object.freeze({
		confirmed: report.confirmed,
		recoveries: Object.freeze(
			report.recoveries.map((recovery) => Object.freeze({ ...recovery }))
		),
		failures: Object.freeze(
			report.failures.map((failure) => {
				const error = rehydrateSandboxError(
					failure,
					failure.cause === undefined ? undefined : { cause: failure.cause }
				);

				Object.defineProperty(error, 'message', { value: failure.message });

				return Object.freeze(error);
			})
		)
	});
}

/**
Recognises sandbox errors without relying on constructor identity. Pass a
concrete error class to narrow an unknown value across separate SDK copies.
The guard checks the typed context and the cleanup report.
*/
export function isSandboxError(value: unknown): value is SandboxErrorInfo;
/**
Narrows a compatible error to the supplied concrete class across SDK copies.
The class supplies its stable identity; constructor identity is not compared.

@example
```typescript
if (isSandboxError(error, SandboxTimeoutError)) {
console.error(error.completion);
}
```
*/
export function isSandboxError<
	Class extends { readonly errorName: SandboxErrorName }
>(
	value: unknown,
	errorClass: Class
): value is Extract<SandboxErrorInfo, { readonly name: Class['errorName'] }>;

export function isSandboxError(
	value: unknown,
	errorClass?: { readonly errorName: SandboxErrorName }
): value is SandboxErrorInfo {
	return (
		(typeof value !== 'object' ||
			value === null ||
			areCloseReportsAcyclic(Reflect.get(value, 'closeReport'))) &&
		isError(value) &&
		(errorClass === undefined || value.name === errorClass.errorName)
	);
}
