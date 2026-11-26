import { expect, it } from 'vitest';

import type { ProtocolIdentity } from './protocol-envelope.js';
import { compareBuilds } from './protocol-version.js';

const identity: ProtocolIdentity = {
	major: 1,
	featureLevel: 0,
	packageVersion: '1.1.0',
	buildId: 'build-a',
	extensionSource: '/extensions/a.ts'
};

it.each([
	[{ packageVersion: '0.0.0', featureLevel: 1 }, { packageVersion: '3.0.0' }],
	[{ packageVersion: '1.10.0' }, { packageVersion: '1.9.0' }],
	[{ packageVersion: '2.0.0' }, { packageVersion: '2.0.0-rc.100' }],
	[{ packageVersion: '2.0.0-rc.10' }, { packageVersion: '2.0.0-rc.9' }],
	[{ packageVersion: '2.0.0-rc.abc' }, { packageVersion: '2.0.0-rc.10' }],
	[
		{ packageVersion: '2.0.0+a', buildId: 'z' },
		{ packageVersion: '2.0.0+z', buildId: 'a' }
	],
	[
		{ extensionSource: '/extensions/a.ts' },
		{ extensionSource: '/extensions/Z.ts' }
	]
] as const)(
	'elects by feature level, package precedence, build and path (%j, %j)',
	(higher, lower) => {
		const a = { ...identity, ...higher };
		const b = { ...identity, ...lower };

		expect({
			higherFirst: Math.sign(compareBuilds(a, b)),
			lowerFirst: Math.sign(compareBuilds(b, a)),
			same: compareBuilds(a, a)
		}).toStrictEqual({ higherFirst: 1, lowerFirst: -1, same: 0 });
	}
);
