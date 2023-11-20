import type * as html from 'vscode-html-languageservice';
import type { PugDocument } from '../pugDocument';
import { transformHover } from '@volar/language-service';

export function register(htmlLs: html.LanguageService) {
	return (pugDoc: PugDocument, pos: html.Position, options?: html.HoverSettings | undefined) => {

		const htmlPos = pugDoc.map.toGeneratedPosition(pos);
		if (!htmlPos)
			return;

		const htmlResult = htmlLs.doHover(
			pugDoc.map.virtualFileDocument,
			htmlPos,
			pugDoc.htmlDocument,
			options,
		);
		if (!htmlResult) return;

		return transformHover(htmlResult, htmlRange => pugDoc.map.toSourceRange(htmlRange));
	};
}
