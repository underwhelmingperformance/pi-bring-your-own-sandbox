import { createEventBus } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { ensureExtensionService } from './extension-services.js';
import { callable, checker, nonEmptyStringSchema } from './schemas.js';

const isService = checker(
	Type.Object({ id: nonEmptyStringSchema, read: callable<() => number>() })
);

it('reserves a service before a constructor re-enters discovery', () => {
	const events = createEventBus();
	let constructions = 0;
	const create = (id: string) => {
		constructions++;

		if (constructions === 1) {
			expect(() =>
				ensureExtensionService(events, 'fixture', isService, create)
			).toThrow(
				expect.objectContaining({ name: 'SandboxInitialisationError' })
			);
		}

		return { id, read: () => 42 };
	};

	const first = ensureExtensionService(events, 'fixture', isService, create);
	const second = ensureExtensionService(events, 'fixture', isService, create);

	expect({
		constructions,
		same: first === second,
		value: second.read()
	}).toStrictEqual({ constructions: 1, same: true, value: 42 });
});

it('retains a failed constructor instead of attempting a second service', () => {
	const events = createEventBus();
	let constructions = 0;
	const create = () => {
		constructions++;

		throw new Error('Constructor failed.');
	};

	expect(() =>
		ensureExtensionService(events, 'fixture', isService, create)
	).toThrow();
	expect(() =>
		ensureExtensionService(events, 'fixture', isService, create)
	).toThrow(expect.objectContaining({ name: 'SandboxInitialisationError' }));
	expect(constructions).toBe(1);
});
