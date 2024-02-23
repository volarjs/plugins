import type * as html from 'vscode-html-languageservice';
import type { PugDocument } from '../pugDocument';
import { transformLocations } from '@volar/language-service';

export function register(htmlLs: html.LanguageService) {
	return (pugDoc: PugDocument, pos: html.Position) => {

		const htmlPos = pugDoc.map.getGeneratedPosition(pos);
		if (!htmlPos)
			return;

		const htmlResult = htmlLs.findDocumentHighlights(
			pugDoc.map.embeddedDocument,
			htmlPos,
			pugDoc.htmlDocument,
		);

		return transformLocations(
			htmlResult,
			htmlRange => pugDoc.map.getSourceRange(htmlRange),
		);
	};
}
