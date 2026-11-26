import type { TSchema } from 'typebox';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

const introduced = 'x-byos-feature-level';
const keepWhole = 'x-byos-whole-offer';
const unrepresentable = Symbol('unrepresentable');

export function introducedAt<Schema extends TSchema>(
	level: number,
	schema: Schema
) {
	return Type.With(schema, { [introduced]: level });
}

export function wholeOffer<Schema extends TSchema>(schema: Schema) {
	return Type.With(schema, { [keepWhole]: true });
}

function featureLevelOf(schema: TSchema): number {
	const level: unknown = Object.getOwnPropertyDescriptor(
		schema,
		introduced
	)?.value;

	return typeof level === 'number' ? level : 0;
}

function projectChildren(value: unknown, level: number): unknown {
	if (Array.isArray(value)) {
		const children: readonly unknown[] = value;

		return children.map((child) => projectChildren(child, level));
	}

	if (
		typeof value === 'object' &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		if (Type.IsSchema(value)) {
			return atFeatureLevel(value, level);
		}

		return Object.fromEntries(
			Object.entries<unknown>(value).map(([key, child]) => [
				key,
				projectChildren(child, level)
			])
		);
	}

	return value;
}

export function atFeatureLevel(schema: TSchema, level: number): TSchema {
	if (featureLevelOf(schema) > level) {
		return Type.Never();
	}

	const entries: [string, unknown][] = Object.entries(schema);

	if (Type.IsObject(schema)) {
		const fields = Object.entries(schema.properties);

		for (const [key, field] of fields) {
			if (featureLevelOf(field) > 0 && !Type.IsOptional(field)) {
				throw new Error(`Protocol field ${key} must be optional when added.`);
			}
		}

		const properties = Object.fromEntries(
			fields
				.filter(([, field]) => featureLevelOf(field) <= level)
				.map(([key, field]) => [key, atFeatureLevel(field, level)])
		);

		return Type.With(schema, {
			...Object.fromEntries(
				entries
					.filter(([key]) => key !== 'properties')
					.map(([key, value]) => [key, projectChildren(value, level)])
			),
			properties
		});
	}

	if (Type.IsUnion(schema)) {
		return Type.With(schema, {
			anyOf: schema.anyOf
				.filter((member) => featureLevelOf(member) <= level)
				.map((member) => atFeatureLevel(member, level))
		});
	}

	return Type.With(
		schema,
		Object.fromEntries(
			entries.map(([key, value]) => [key, projectChildren(value, level)])
		)
	);
}

const checks = new WeakMap<TSchema, Map<number, (value: unknown) => boolean>>();

export function isValidAtFeatureLevel(
	schema: TSchema,
	level: number,
	value: unknown
): boolean {
	let levels = checks.get(schema);

	if (levels === undefined) {
		levels = new Map();
		checks.set(schema, levels);
	}

	let check = levels.get(level);

	if (check === undefined) {
		const compiled = Compile(atFeatureLevel(schema, level));

		check = (input) => compiled.Check(input);
		levels.set(level, check);
	}

	return check(value);
}

function reducedValue(schema: TSchema, value: unknown, level: number): unknown {
	if (featureLevelOf(schema) > level) {
		return unrepresentable;
	}

	if (isValidAtFeatureLevel(schema, level, value)) {
		return value;
	}

	if (Object.getOwnPropertyDescriptor(schema, keepWhole)?.value === true) {
		return unrepresentable;
	}

	if (Type.IsUnion(schema)) {
		const member = schema.anyOf.find((candidate) =>
			isValidAtFeatureLevel(candidate, Number.MAX_SAFE_INTEGER, value)
		);

		return member === undefined
			? unrepresentable
			: reducedValue(member, value, level);
	}

	if (Type.IsArray(schema) && Array.isArray(value)) {
		const items: readonly unknown[] = value;
		const reduced = items
			.map((item) => reducedValue(schema.items, item, level))
			.filter((item) => item !== unrepresentable);

		return isValidAtFeatureLevel(schema, level, reduced)
			? reduced
			: unrepresentable;
	}

	if (typeof value === 'object' && value !== null && Type.IsObject(schema)) {
		const fields: [string, unknown][] = [];

		for (const [key, field] of Object.entries(schema.properties)) {
			const original: unknown = Reflect.get(value, key);

			if (original === undefined && Type.IsOptional(field)) {
				continue;
			}

			const fieldValue = reducedValue(field, original, level);

			if (fieldValue !== unrepresentable) {
				fields.push([key, fieldValue]);
			}
		}

		const reduced = Object.fromEntries(fields);

		return isValidAtFeatureLevel(schema, level, reduced)
			? reduced
			: unrepresentable;
	}

	return unrepresentable;
}

export function projectOffer(
	schema: TSchema,
	value: unknown,
	level: number
): unknown {
	if (!isValidAtFeatureLevel(schema, Number.MAX_SAFE_INTEGER, value)) {
		return undefined;
	}

	const result = reducedValue(schema, value, level);

	return result === unrepresentable ? undefined : result;
}
