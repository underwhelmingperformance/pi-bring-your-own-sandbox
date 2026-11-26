import { createHash } from 'node:crypto';

import type { TSchema } from 'typebox';

import { atFeatureLevel } from './protocol-schema.js';

type Description =
	| null
	| boolean
	| number
	| string
	| readonly Description[]
	| { readonly [key: string]: Description };

function describe(value: unknown): Description {
	if (typeof value === 'function') {
		return {
			implementation: createHash('sha256')
				.update(Function.prototype.toString.call(value))
				.digest('hex')
		};
	}

	if (value instanceof RegExp) {
		return { pattern: value.source, flags: value.flags };
	}

	if (Array.isArray(value)) {
		const elements: readonly unknown[] = value;

		return elements.map((element) => describe(element));
	}

	if (typeof value === 'object' && value !== null) {
		const fields = Object.getOwnPropertyNames(value).toSorted(
			(left, right) => Number(left > right) - Number(left < right)
		);

		return Object.fromEntries(
			fields.map((key) => {
				const field: unknown = Reflect.get(value, key);

				return [key, describe(field)];
			})
		);
	}

	if (
		value === null ||
		typeof value === 'boolean' ||
		typeof value === 'number' ||
		typeof value === 'string'
	) {
		return value;
	}

	throw new TypeError('The protocol schema contains an unsupported value.');
}

export function protocolSnapshot(
	major: number,
	featureLevel: number,
	schemas: Readonly<Record<string, TSchema>>
): Description {
	const projected = Object.entries(schemas).map(
		([name, schema]): [string, TSchema] => [
			name,
			atFeatureLevel(schema, featureLevel)
		]
	);

	return describe({
		major,
		featureLevel,
		schemas: Object.fromEntries(projected)
	});
}
