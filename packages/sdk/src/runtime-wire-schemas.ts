import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { SandboxHost, SandboxHostHandle } from './contracts.js';
import { closeReportSchema } from './error-schema.js';
import { providerInfoSchema } from './policy-model.js';
import { protocolIdentitySchema } from './protocol-envelope.js';
import type {
	RuntimeParticipant,
	RuntimeProvider,
	ShellSettings
} from './runtime-participant.js';
import {
	callable,
	denseArray,
	hostUserDataRootsSchema,
	nonEmptyStringSchema,
	safeTextSchema,
	signalSchema
} from './schemas.js';
import { hostOptionsSchema } from './service-schemas.js';
import type {
	ClaimShellCall,
	ShellRouteRegistration
} from './shell-review-routes.js';

const sessionContext = Type.Ref('runtime.context');
const noResult = Type.Undefined();
const close = callable<SandboxHostHandle['close']>(
	[],
	closeReportSchema,
	'async'
);

const eventHandler = callable<(value: unknown) => void>(
	[Type.Unknown()],
	noResult
);
const unsubscribe = callable<() => void>([], noResult);
const eventBus = Type.Object({
	on: callable<SandboxHost['events']['on']>(
		[nonEmptyStringSchema, eventHandler],
		unsubscribe
	),
	emit: callable<SandboxHost['events']['emit']>(
		[nonEmptyStringSchema, Type.Unknown()],
		noResult
	)
});
const lifecycleHandler = callable<(...arguments_: unknown[]) => unknown>(
	[Type.Unknown(), sessionContext],
	Type.Unknown(),
	'sync-or-async'
);
const optionalPiData = Type.Optional(Type.Unknown());
const piHostShape = Type.Object({
	events: eventBus,
	on: callable<SandboxHost['on']>(
		[nonEmptyStringSchema, lifecycleHandler],
		unsubscribe
	),
	getActiveTools: callable<SandboxHost['getActiveTools']>(
		[],
		Type.Array(nonEmptyStringSchema)
	),
	sendMessage: callable<SandboxHost['sendMessage']>(
		[Type.Unknown(), optionalPiData],
		noResult
	),
	appendEntry: callable<SandboxHost['appendEntry']>(
		[nonEmptyStringSchema, optionalPiData],
		noResult
	)
});
const piHostSchema = Type.Unsafe<SandboxHost>(piHostShape);

const shellSettingsResult = Type.Object({
	allowEscalation: Type.Boolean(),
	providerId: nonEmptyStringSchema,
	hostUserDataRoots: Type.Optional(hostUserDataRootsSchema)
});

export const shellSettingsSchema = Type.Object({
	lifetime: signalSchema,
	read: callable<ShellSettings['read']>(
		[sessionContext],
		shellSettingsResult,
		'async'
	)
});

type Dispatch = ReturnType<ClaimShellCall>;

const openShell = callable<NonNullable<Dispatch['open']>>(
	[safeTextSchema, Type.Ref('sandbox.operationOptions')],
	Type.Ref('sandbox.ownedCopy'),
	'async'
);

export const shellDispatchSchema = Type.Object({
	prefix: Type.Union([safeTextSchema, Type.Undefined()]),
	open: Type.Optional(openShell),
	finish: callable<Dispatch['finish']>([], noResult)
});

const shellClaim = callable<ClaimShellCall>(
	[nonEmptyStringSchema, Type.Unknown(), sessionContext],
	Type.Ref('runtime.shellDispatch')
);

const shellRoute = Type.Object({
	pi: Type.Unsafe<ExtensionAPI>(piHostSchema),
	toolName: Type.Union([Type.Literal('bash'), Type.Literal('powershell')]),
	identity: protocolIdentitySchema,
	parameters: Type.Refine(Type.Unknown(), (value) => Type.IsSchema(value)),
	receive: callable<ShellRouteRegistration['receive']>(
		[shellClaim, Type.Ref('runtime.shellSettings')],
		noResult
	)
});

const configureProvider = callable<NonNullable<RuntimeProvider['configure']>>(
	[Type.Ref('provider.configContext')],
	Type.Ref('provider.configured'),
	'async'
);
const runtimeProvider = Type.Object({
	...providerInfoSchema.properties,
	protocol: protocolIdentitySchema,
	configure: Type.Optional(configureProvider)
});
const hostRegistration = Type.Object({
	options: hostOptionsSchema,
	receive: callable<NonNullable<RuntimeParticipant['host']>['receive']>(
		[close],
		noResult
	)
});
const participantShape = Type.Object({
	providers: denseArray(runtimeProvider),
	host: Type.Optional(hostRegistration),
	shellRoutes: denseArray(shellRoute),
	commit: callable<RuntimeParticipant['commit']>([], noResult)
});

export const runtimeParticipantSchema =
	Type.Unsafe<RuntimeParticipant>(participantShape);
