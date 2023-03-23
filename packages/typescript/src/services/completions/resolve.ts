import { SharedContext } from '../../types';
import type * as ts from 'typescript/lib/tsserverlibrary';
import * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getFormatCodeSettings } from '../../configs/getFormatCodeSettings';
import { getUserPreferences } from '../../configs/getUserPreferences';
import { getConfigTitle } from '../../shared';
import * as previewer from '../../utils/previewer';
import { snippetForFunctionCall } from '../../utils/snippetForFunctionCall';
import { entriesToLocations } from '../../utils/transforms';
import type { Data } from './basic';
import { handleKindModifiers } from './basic';

export function register(ctx: SharedContext) {
	const ts = ctx.typescript!.module;

	return async (item: vscode.CompletionItem, newPosition?: vscode.Position): Promise<vscode.CompletionItem> => {

		const data: Data | undefined = item.data;

		if (!data)
			return item;

		const fileName = data.fileName;
		let offset = data.offset;
		const document = ctx.getTextDocument(data.uri);

		if (newPosition && document) {
			offset = document.offsetAt(newPosition);
		}

		const [formatOptions, preferences] = document ? await Promise.all([
			getFormatCodeSettings(ctx, document),
			getUserPreferences(ctx, document),
		]) : [{}, {}];

		let details: ts.CompletionEntryDetails | undefined;
		try {
			details = ctx.typescript.languageService.getCompletionEntryDetails(fileName, offset, data.originalItem.name, formatOptions, data.originalItem.source, preferences, data.originalItem.data);
		}
		catch (err) {
			item.detail = `[TS Error]\n${err}\n${JSON.stringify(err, undefined, 2)}`;
		}

		if (!details)
			return item;

		if (data.originalItem.labelDetails) {
			item.labelDetails ??= {};
			Object.assign(item.labelDetails, data.originalItem.labelDetails);
		}

		const { sourceDisplay } = details;
		if (sourceDisplay) {
			item.labelDetails ??= {};
			item.labelDetails.description = ts.displayPartsToString(sourceDisplay);
		}

		const detailTexts: string[] = [];
		if (details.codeActions) {
			if (!item.additionalTextEdits) item.additionalTextEdits = [];
			for (const action of details.codeActions) {
				detailTexts.push(action.description);
				for (const changes of action.changes) {
					const entries = changes.textChanges.map(textChange => {
						return { fileName, textSpan: textChange.span };
					});
					const locs = entriesToLocations(entries, ctx);
					locs.forEach((loc, index) => {
						item.additionalTextEdits?.push(vscode.TextEdit.replace(loc.range, changes.textChanges[index].newText));
					});
				}
			}
		}
		if (details.displayParts) {
			detailTexts.push(previewer.plainWithLinks(details.displayParts, { toResource }, ctx));
		}
		if (detailTexts.length) {
			item.detail = detailTexts.join('\n');
		}

		item.documentation = {
			kind: 'markdown',
			value: previewer.markdownDocumentation(details.documentation, details.tags, { toResource }, ctx),
		};

		if (details) {
			handleKindModifiers(item, details);
		}

		if (document) {

			const useCodeSnippetsOnMethodSuggest = await ctx.configurationHost?.getConfiguration<boolean>(getConfigTitle(document) + '.suggest.completeFunctionCalls') ?? false;
			const useCodeSnippet = useCodeSnippetsOnMethodSuggest && (item.kind === vscode.CompletionItemKind.Function || item.kind === vscode.CompletionItemKind.Method);

			if (useCodeSnippet) {
				const shouldCompleteFunction = isValidFunctionCompletionContext(ctx.typescript.languageService, fileName, offset, document);
				if (shouldCompleteFunction) {
					const { snippet, parameterCount } = snippetForFunctionCall(
						{
							insertText: item.insertText ?? item.textEdit?.newText, // insertText is dropped by LSP in some case: https://github.com/microsoft/vscode-languageserver-node/blob/9b742021fb04ad081aa3676a9eecf4fa612084b4/client/src/common/codeConverter.ts#L659-L664
							label: item.label,
						},
						details.displayParts,
					);
					if (item.textEdit) {
						item.textEdit.newText = snippet;
					}
					if (item.insertText) {
						item.insertText = snippet;
					}
					item.insertTextFormat = vscode.InsertTextFormat.Snippet;
					if (parameterCount > 0) {
						//Fix for https://github.com/microsoft/vscode/issues/104059
						//Don't show parameter hints if "editor.parameterHints.enabled": false
						// if (await getConfiguration('editor.parameterHints.enabled', document.uri)) {
						// 	item.command = {
						// 		title: 'triggerParameterHints',
						// 		command: 'editor.action.triggerParameterHints',
						// 	};
						// }
					}
				}
			}
		}

		return item;

		function toResource(path: string) {
			return ctx.fileNameToUri(path);
		}
	};
}

function isValidFunctionCompletionContext(
	client: ts.LanguageService,
	filepath: string,
	offset: number,
	document: TextDocument,
): boolean {
	// Workaround for https://github.com/microsoft/TypeScript/issues/12677
	// Don't complete function calls inside of destructive assignments or imports
	try {
		const response = client.getQuickInfoAtPosition(filepath, offset);
		if (response) {
			switch (response.kind) {
				case 'var':
				case 'let':
				case 'const':
				case 'alias':
					return false;
			}
		}
	} catch {
		// Noop
	}

	// Don't complete function call if there is already something that looks like a function call
	// https://github.com/microsoft/vscode/issues/18131
	const position = document.positionAt(offset);
	const after = getLineText(document, position.line).slice(position.character);
	return after.match(/^[a-z_$0-9]*\s*\(/gi) === null;
}

export function getLineText(document: TextDocument, line: number) {
	const endOffset = document.offsetAt({ line: line + 1, character: 0 });
	const end = document.positionAt(endOffset);
	const text = document.getText({
		start: { line: line, character: 0 },
		end: end.line === line ? end : document.positionAt(endOffset - 1),
	});
	return text;
}
