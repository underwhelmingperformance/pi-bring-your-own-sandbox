import type { Profile } from 'pi-bring-your-own-sandbox/provider';

export function firstOpenProfile(provider: {
	readonly profiles: { readonly open: readonly Profile[] };
}): Profile {
	const [profile] = provider.profiles.open;

	if (profile === undefined) {
		throw new Error('The fixture provider declares no open profile.');
	}

	return profile;
}

export function firstCopyProfile(provider: {
	readonly profiles: { readonly copy: readonly Profile[] };
}): Profile {
	const [profile] = provider.profiles.copy;

	if (profile === undefined) {
		throw new Error('The fixture provider declares no copy profile.');
	}

	return profile;
}
