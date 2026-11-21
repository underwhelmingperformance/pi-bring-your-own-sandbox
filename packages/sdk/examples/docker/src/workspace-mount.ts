import type { SandboxOperationContext } from 'pi-bring-your-own-sandbox/api';

export interface DockerMountService {
	readonly controlVolume: string;
	readonly bootstrap: string;
	readonly hasAppArmor: boolean;
	assertConnected(context: SandboxOperationContext): void;
}

export interface DockerWorkspaceMount {
	readonly mount: string | DockerMountService;
	readonly readOnly: boolean;
}

export function mount(fields: readonly string[]): string {
	return fields.map((field) => `"${field.replaceAll('"', '""')}"`).join(',');
}

export function workspaceCommand(
	workspace: DockerWorkspaceMount,
	purpose: 'launcher' | 'worker',
	image: string,
	executable: string,
	arguments_: readonly string[]
): string[] {
	const service = workspace.mount;

	if (typeof service === 'string') {
		return [
			'--mount',
			service,
			'--entrypoint=' + executable,
			image,
			...arguments_
		];
	}

	return [
		'--mount',
		mount([
			'type=volume',
			'source=' + service.controlVolume,
			'target=/control'
		]),
		'--mount',
		mount([
			'type=bind',
			'source=' + service.bootstrap,
			'target=/mount-check',
			'readonly'
		]),
		...(service.hasAppArmor
			? ['--security-opt=apparmor=byos-mount-probe']
			: []),
		'--device=/dev/fuse',
		'--cap-add=SYS_ADMIN',
		'--cap-add=SETPCAP',
		...(purpose === 'worker' ? ['--cap-add=SETUID', '--cap-add=SETGID'] : []),
		'--tmpfs=/workspace:rw,nosuid,nodev',
		'--entrypoint=/mount-check',
		image,
		purpose === 'launcher' ? 'mount-launcher' : 'mount',
		workspace.readOnly ? 'read-only' : 'read-write',
		executable,
		...arguments_
	];
}
