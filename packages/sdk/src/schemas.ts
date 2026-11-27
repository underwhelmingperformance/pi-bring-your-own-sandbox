import type { Static, TArrayOptions, TSchema } from 'typebox';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

export function checker<Schema extends TSchema>(schema: Schema) {
	const validator = Compile(schema);

	return (value: unknown): value is Static<Schema> => validator.Check(value);
}

export function denseArray<Item extends TSchema>(
	item: Item,
	options?: TArrayOptions
) {
	return Type.Refine(Type.Array(item, options), (items) =>
		items.values().every((_, index) => Object.hasOwn(items, index))
	);
}

export function callable<Signature extends (...arguments_: never[]) => unknown>(
	parameters?: readonly TSchema[],
	returnType: TSchema = Type.Unknown(),
	resultMode: 'sync' | 'async' | 'sync-or-async' = 'sync'
) {
	const signature = Type.Function([...(parameters ?? [])], returnType);

	return Type.Unsafe<Signature>(
		parameters === undefined
			? signature
			: Type.With(signature, {
					'x-byos-result-mode': resultMode,
					'x-byos-failure': Type.Ref('error')
				})
	);
}

export const recordSchema = Type.Record(Type.String(), Type.Unknown());
export const nonEmptyStringSchema = Type.String({ minLength: 1 });
export const safeTextSchema = Type.String({ pattern: '^[^\\u0000]*$' });
export const targetPathSchema = Type.String({
	minLength: 1,
	pattern: '^[^\\u0000]*$'
});
export const hostUserDataRootsSchema = denseArray(targetPathSchema, {
	uniqueItems: true
});
export const safeIntegerSchema = Type.Integer({
	minimum: Number.MIN_SAFE_INTEGER,
	maximum: Number.MAX_SAFE_INTEGER
});
export const nonNegativeIntegerSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER
});
export const positiveIntegerSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER
});
export const timeoutSchema = Type.Number({
	exclusiveMinimum: 0,
	maximum: Number.MAX_VALUE
});
export const shellSchema = Type.Union([
	Type.Literal('bash'),
	Type.Literal('sh'),
	Type.Literal('powershell')
]);
export const capabilitySchema = Type.Union([
	Type.Literal('files.read'),
	Type.Literal('files.write'),
	Type.Literal('files.list'),
	Type.Literal('search.find'),
	Type.Literal('search.grep')
]);
export const processKindSchema = Type.Union([
	Type.Literal('argv'),
	Type.Literal('shell')
]);

export const terminationScopeSchema = Type.Union([
	Type.Literal('process-group'),
	Type.Literal('workload')
]);

export const workspaceRelationshipSchema = Type.Union([
	Type.Literal('shared'),
	Type.Literal('copied')
]);

export const recoverySchema = Type.Union([
	Type.Object({ kind: Type.Literal('none') }),
	Type.Object({
		kind: Type.Literal('allocation'),
		id: nonEmptyStringSchema,
		instructions: nonEmptyStringSchema,
		lease: nonEmptyStringSchema
	})
]);

export const bytesSchema = Type.Unsafe<Uint8Array>(
	Type.Refine(Type.Unknown(), (value) => value instanceof Uint8Array)
);

const eventSchema = Type.Object({
	type: nonEmptyStringSchema,
	defaultPrevented: Type.Boolean()
});
const eventListener = callable<(event: Event) => void>(
	[eventSchema],
	Type.Undefined()
);
const eventListenerSchema = Type.Union([
	eventListener,
	Type.Object({ handleEvent: eventListener }),
	Type.Null()
]);
const listenerCaptureSchema = Type.Object({
	capture: Type.Optional(Type.Boolean())
});

const listenerSignal = Type.Optional(Type.Ref('sandbox.signal'));
const listenerOptions = Type.Object({
	...listenerCaptureSchema.properties,
	once: Type.Optional(Type.Boolean()),
	passive: Type.Optional(Type.Boolean()),
	signal: listenerSignal
});
const listenerSetupOptions = Type.Optional(
	Type.Union([Type.Boolean(), listenerOptions])
);
const listenerRemovalOptions = Type.Optional(
	Type.Union([Type.Boolean(), listenerCaptureSchema])
);
const noListenerResult = Type.Undefined();

const signalShape = Type.Object({
	aborted: Type.Boolean(),
	addEventListener: callable<AbortSignal['addEventListener']>(
		[nonEmptyStringSchema, eventListenerSchema, listenerSetupOptions],
		noListenerResult
	),
	removeEventListener: callable<AbortSignal['removeEventListener']>(
		[nonEmptyStringSchema, eventListenerSchema, listenerRemovalOptions],
		noListenerResult
	),
	dispatchEvent: callable<AbortSignal['dispatchEvent']>(
		[eventSchema],
		Type.Boolean()
	),
	throwIfAborted: callable<AbortSignal['throwIfAborted']>([], noListenerResult),
	reason: Type.Unknown()
});

export const signalSchema = Type.Unsafe<AbortSignal>(signalShape);
