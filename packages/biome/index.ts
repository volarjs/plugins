import { Biome, Distribution } from "@biomejs/js-api";
import type { DocumentSelector, Result, ServiceContext, ServicePlugin, ServicePluginInstance } from '@volar/language-service';

interface BiomeServiceOptions {
	documentSelector?: DocumentSelector;
	distribution?: 'node' | 'web';
}


export function create(
	biomeDistributionInstanceOrGetter: typeof import('@biomejs/wasm-nodejs') | typeof import('@biomejs/wasm-web') | ((context: ServiceContext) => Result<typeof import('@biomejs/wasm-nodejs') | typeof import('@biomejs/wasm-web') | undefined>),
	{ documentSelector = ['typescript', 'javascript'], distribution = 'node' }: BiomeServiceOptions = {},
): ServicePlugin {
	return {
		name: 'biome',
		create(context): ServicePluginInstance {
			let biomeInstanceOrPromise: Result<typeof import('@biomejs/wasm-nodejs') | typeof import('@biomejs/wasm-web') | undefined>;
			let biome: Biome | undefined = undefined;

			return {
				async provideDocumentFormattingEdits(document) {
					if (!matchDocument(documentSelector, document)) {
						return;
					}

					biomeInstanceOrPromise ??= typeof biomeDistributionInstanceOrGetter === 'function'
						? await biomeDistributionInstanceOrGetter(context)
						: biomeDistributionInstanceOrGetter;

					if (!biomeInstanceOrPromise) {
						return;
					}

					biome ??= await Biome.create({
						distribution: distribution === 'node' ? Distribution.NODE : Distribution.WEB,
					});

					const newText = biome.formatContent(document.getText(), {
						filePath: document.uri,
					});

					const fullText = document.getText();

					return [{
						newText: newText.content,
						range: {
							start: document.positionAt(0),
							end: document.positionAt(fullText.length),
						},
					}];
				},
			};
		},
	};
}

function matchDocument(selector: DocumentSelector, document: { languageId: string; }) {
	for (const sel of selector) {
		if (sel === document.languageId || (typeof sel === 'object' && sel.language === document.languageId)) {
			return true;
		}
	}
	return false;
}
