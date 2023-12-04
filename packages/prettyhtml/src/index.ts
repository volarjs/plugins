import type { Service, ServicePlugin } from '@volar/language-service';
import * as prettyhtml from '@starptech/prettyhtml';

export function create(configs: NonNullable<Parameters<typeof prettyhtml>[1]>): ServicePlugin {
	return {
		create(): Service {
			return {
				provideDocumentFormattingEdits(document, range, options) {

					if (document.languageId !== 'html')
						return;

					const oldRangeText = document.getText(range);
					const newRangeText = prettyhtml(oldRangeText, {
						...configs,
						tabWidth: options.tabSize,
						useTabs: !options.insertSpaces,
					}).contents;

					if (newRangeText === oldRangeText)
						return [];

					const newText = document.getText({
						start: document.positionAt(0),
						end: range.start,
					})
						+ newRangeText
						+ document.getText({
							start: range.end,
							end: document.positionAt(document.getText().length),
						});

					return [{
						newText,
						range: {
							start: document.positionAt(0),
							end: document.positionAt(document.getText().length),
						},
					}];
				},
			};
		},
	};
}
