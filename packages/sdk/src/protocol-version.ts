import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { cleanDisplayText } from './display-text.js';
import {
	IncompatibleSandboxProtocolError,
	InvalidSandboxRequestError
} from './errors.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { isValidAtFeatureLevel, projectOffer } from './protocol-schema.js';
import { isRecord } from './validation.js';

const numeric = '(?:0|[1-9][0-9]*)';
const prereleasePart = `(?:${numeric}|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)`;
const version = new RegExp(
	`^${numeric}\\.${numeric}\\.${numeric}(?:-${prereleasePart}(?:\\.${prereleasePart})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`
);

export const packageVersionSchema = Type.String({ pattern: version });

function compareText(left: string, right: string): number {
	return Number(left > right) - Number(left < right);
}

function compareNumber(left: string, right: string): number {
	return left.length - right.length || compareText(left, right);
}

function versionParts(input: string) {
	const end = input.indexOf('+');
	const value = end === -1 ? input : input.slice(0, end);
	const split = value.indexOf('-');

	return split === -1
		? { core: value.split('.'), prerelease: [] }
		: {
				core: value.slice(0, split).split('.'),
				prerelease: value.slice(split + 1).split('.')
			};
}

function compareVersion(left: string, right: string): number {
	const a = versionParts(left);
	const b = versionParts(right);

	for (const [index, part] of a.core.entries()) {
		const order = compareNumber(part, b.core[index] ?? '0');

		if (order !== 0) {
			return order;
		}
	}

	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return Number(b.prerelease.length > 0) - Number(a.prerelease.length > 0);
	}

	for (const [index, part] of a.prerelease.entries()) {
		const other = b.prerelease[index];

		if (other === undefined) {
			return 1;
		}

		const isNumber = /^[0-9]+$/.test(part);
		const isOtherNumber = /^[0-9]+$/.test(other);
		const order =
			isNumber && isOtherNumber
				? compareNumber(part, other)
				: Number(isOtherNumber) - Number(isNumber) || compareText(part, other);

		if (order !== 0) {
			return order;
		}
	}

	return a.prerelease.length - b.prerelease.length;
}

export function compareBuilds(
	a: ProtocolIdentity,
	b: ProtocolIdentity
): number {
	return (
		a.featureLevel - b.featureLevel ||
		compareVersion(a.packageVersion, b.packageVersion) ||
		compareText(a.buildId, b.buildId) ||
		compareText(a.extensionSource, b.extensionSource)
	);
}

export function sharedFeatureLevel(
	local: ProtocolIdentity,
	peer: ProtocolIdentity
): number {
	if (local.major !== peer.major) {
		throw new IncompatibleSandboxProtocolError({
			operation: 'discover',
			protocolMessage: cleanDisplayText(
				`Protocol major ${String(local.major)} from ${local.extensionSource} (build ${local.buildId}) is incompatible with major ${String(peer.major)} from ${peer.extensionSource} (build ${peer.buildId}). Update the extensions together.`
			)
		});
	}

	return Math.min(local.featureLevel, peer.featureLevel);
}

export function unavailableFeature(
	operation: string,
	level: number,
	older: ProtocolIdentity
): IncompatibleSandboxProtocolError {
	return new IncompatibleSandboxProtocolError({
		operation: 'discover',
		protocolMessage: cleanDisplayText(
			`The ${operation} requires a feature above protocol level ${String(level)}. Update ${older.extensionSource} (build ${older.buildId}).`
		)
	});
}

export function checkDemand(
	schema: TSchema,
	value: unknown,
	local: ProtocolIdentity,
	peer: ProtocolIdentity,
	operation: string
): void {
	const level = sharedFeatureLevel(local, peer);

	if (isValidAtFeatureLevel(schema, level, value)) {
		return;
	}

	if (!isValidAtFeatureLevel(schema, local.featureLevel, value)) {
		throw new InvalidSandboxRequestError({ operation: 'acquire' });
	}

	const older = local.featureLevel < peer.featureLevel ? local : peer;

	throw unavailableFeature(operation, level, older);
}

export function projectReply(
	schema: TSchema,
	payload: { readonly type: string; readonly [key: string]: unknown },
	local: ProtocolIdentity,
	request: ProtocolIdentity
): { readonly type: string; readonly [key: string]: unknown } {
	if (local.major !== request.major) {
		return { type: 'incompatible-major' };
	}

	const projected = projectOffer(
		schema,
		payload,
		Math.min(local.featureLevel, request.featureLevel)
	);

	return isRecord(projected) && typeof projected['type'] === 'string'
		? { ...projected, type: projected['type'] }
		: { type: 'unrepresentable-offer', service: payload.type };
}
