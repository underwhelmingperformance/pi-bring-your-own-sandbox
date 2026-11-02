import path from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import type { SandboxWorkspace } from './contracts.js';
import {
	bytesSchema,
	denseArray,
	nonEmptyStringSchema,
	nonNegativeIntegerSchema,
	positiveIntegerSchema,
	safeIntegerSchema,
	targetPathSchema
} from './schemas.js';

type PathFlavor = SandboxWorkspace['pathFlavor'];

export const fileStatSchema = Type.Object({
	kind: Type.Enum(['file', 'directory', 'other']),
	size: nonNegativeIntegerSchema
});

function relativePathSchema(flavor: PathFlavor) {
	return Type.Refine(targetPathSchema, (value) => {
		const segments =
			flavor === 'posix' ? value.split('/') : value.split(/[/\\]/u);

		return (
			path[flavor].parse(value).root === '' &&
			segments.every((segment) => !['', '.', '..'].includes(segment))
		);
	});
}

function pathIdentity(value: string, flavor: PathFlavor): string {
	return flavor === 'win32' ? value.replaceAll('\\', '/') : value;
}

function findPath(value: string, flavor: PathFlavor): string {
	return value.endsWith('/') || (flavor === 'win32' && value.endsWith('\\'))
		? value.slice(0, -1)
		: value;
}

export function directoryEntriesSchema(flavor: PathFlavor) {
	const entry = Type.Object({
		name: Type.Refine(
			targetPathSchema,
			(value) =>
				value !== '.' &&
				value !== '..' &&
				path[flavor].basename(value) === value
		),
		kind: Type.Enum(['file', 'directory', 'symlink', 'other'])
	});

	return Type.Refine(
		denseArray(entry),
		(entries) =>
			new Set(entries.map((value) => value.name)).size === entries.length
	);
}

export function findResultSchema(flavor: PathFlavor, limit: number) {
	const relative = relativePathSchema(flavor);
	const entry = Type.Refine(Type.String(), (value) =>
		Value.Check(relative, findPath(value, flavor))
	);
	const paths = denseArray(entry, { maxItems: limit });
	const schema = Type.Union([
		Type.Object({ paths, truncated: Type.Literal(false) }),
		Type.Object({
			paths: Type.With(paths, { minItems: limit }),
			truncated: Type.Literal(true)
		})
	]);

	return Type.Refine(
		schema,
		(value) =>
			new Set(
				value.paths.map((entry) =>
					pathIdentity(findPath(entry, flavor), flavor)
				)
			).size === value.paths.length
	);
}

const lineSchema = Type.String({ pattern: '^[^\\u0000\\n]*$' });

export function grepResultSchema(
	flavor: PathFlavor,
	limit: number,
	context: number
) {
	const match = Type.Refine(
		Type.Object({
			path: relativePathSchema(flavor),
			line: positiveIntegerSchema,
			text: lineSchema,
			before: denseArray(lineSchema, { maxItems: context }),
			after: denseArray(lineSchema, { maxItems: context })
		}),
		(value) => value.before.length < value.line
	);
	const matches = denseArray(match, { maxItems: limit });
	const schema = Type.Union([
		Type.Object({ matches, truncated: Type.Literal(false) }),
		Type.Object({
			matches: Type.With(matches, { minItems: limit }),
			truncated: Type.Literal(true)
		})
	]);

	return Type.Refine(
		schema,
		(value) =>
			new Set(
				value.matches.map(
					(entry) =>
						`${pathIdentity(entry.path, flavor)}\0${String(entry.line)}`
				)
			).size === value.matches.length
	);
}

export const processExitSchema = Type.Union([
	Type.Object({ kind: Type.Literal('unavailable') }),
	Type.Object({ kind: Type.Literal('code'), code: safeIntegerSchema }),
	Type.Object({
		kind: Type.Literal('signal'),
		signal: nonEmptyStringSchema,
		signalNumber: positiveIntegerSchema
	})
]);
export const processOutcomeSchema = Type.Union([
	Type.Object({ kind: Type.Literal('exited'), exit: processExitSchema }),
	Type.Object({
		kind: Type.Literal('cancelled'),
		termination: Type.Enum(['confirmed', 'unconfirmed'])
	})
]);
export const processOutputSchema = Type.Object({
	stream: Type.Enum(['stdout', 'stderr']),
	data: bytesSchema
});
