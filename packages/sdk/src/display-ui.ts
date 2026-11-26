import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIDialogOptions
} from '@earendil-works/pi-coding-agent';

import type { DisplayText } from './display-text.js';

/**
Show a custom Pi message with cleaned text.
*/
export function sendDisplayMessage(
	pi: Pick<ExtensionAPI, 'sendMessage'>,
	customType: DisplayText,
	content: DisplayText,
	options?: Parameters<ExtensionAPI['sendMessage']>[1]
): void {
	pi.sendMessage({ customType, content, display: true }, options);
}

export function appendDisplayEntry(
	pi: Pick<ExtensionAPI, 'appendEntry'>,
	customType: DisplayText,
	content: DisplayText
): void {
	pi.appendEntry(customType, { content });
}

export function notifyDisplay(
	context: ExtensionContext,
	message: DisplayText,
	type?: Parameters<ExtensionContext['ui']['notify']>[1]
): void {
	context.ui.notify(message, type);
}

export function isDisplayConfirmed(
	context: ExtensionContext,
	title: DisplayText,
	message: DisplayText,
	options?: ExtensionUIDialogOptions
): Promise<boolean> {
	return context.ui.confirm(title, message, options);
}
