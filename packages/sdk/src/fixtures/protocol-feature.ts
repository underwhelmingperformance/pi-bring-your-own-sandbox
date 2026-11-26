import type { TSchema } from 'typebox';
import { Type } from 'typebox';

export function introducedAt<Schema extends TSchema>(
	level: number,
	schema: Schema
) {
	return Type.With(schema, { 'x-byos-feature-level': level });
}
