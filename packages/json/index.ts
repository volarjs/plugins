import type { ServicePlugin, ServicePluginInstance, DocumentSelector, ServiceContext, Disposable } from '@volar/language-service';
import * as json from 'vscode-json-languageservice';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { URI, Utils } from 'vscode-uri';

export interface Provide {
	'json/jsonDocument': (document: TextDocument) => json.JSONDocument | undefined;
	'json/languageService': () => json.LanguageService;
}

export interface JSONSchemaSettings {
	fileMatch?: string[];
	url?: string;
	schema?: json.JSONSchema;
	folderUri?: string;
}

export function create({
	documentSelector = ['json', 'jsonc'],
	getWorkspaceContextService = () => {
		return {
			resolveRelativePath(relativePath, resource) {
				const base = resource.substring(0, resource.lastIndexOf('/') + 1);
				return Utils.resolvePath(URI.parse(base), relativePath).toString();
			},
		};
	},
	isFormattingEnabled = async (_document, context) => {
		return await context.env.getConfiguration?.('json.format.enable') ?? true;
	},
	getFormattingOptions = async (_document, context) => {
		return await context.env.getConfiguration?.('json.format');
	},
	getLanguageSettings = async context => {
		const languageSettings: json.LanguageSettings = {};

		languageSettings.validate = await context.env.getConfiguration?.<boolean>('json.validate') ?? true;
		languageSettings.schemas ??= [];

		const schemas = await context.env.getConfiguration?.<JSONSchemaSettings[]>('json.schemas') ?? [];

		for (let i = 0; i < schemas.length; i++) {
			const schema = schemas[i];
			let uri = schema.url;
			if (!uri && schema.schema) {
				uri = schema.schema.id || `vscode://schemas/custom/${i}`;
			}
			if (uri) {
				languageSettings.schemas.push({ uri, fileMatch: schema.fileMatch, schema: schema.schema, folderUri: schema.folderUri });
			}
		}
		return languageSettings;
	},
	getDocumentLanguageSettings = async document => {
		return document.languageId === 'jsonc'
			? { comments: 'ignore', trailingCommas: 'warning' }
			: { comments: 'error', trailingCommas: 'error' };
	},
	onDidChangeLanguageSettings = (listener, context) => {
		const disposable = context.env.onDidChangeConfiguration?.(listener);
		return {
			dispose() {
				disposable?.dispose();
			},
		};
	},
}: {
	documentSelector?: DocumentSelector;
	getWorkspaceContextService?(context: ServiceContext): json.WorkspaceContextService;
	isFormattingEnabled?(document: TextDocument, context: ServiceContext): Promise<boolean>;
	getFormattingOptions?(document: TextDocument, context: ServiceContext): Promise<json.FormattingOptions | undefined>;
	getLanguageSettings?(context: ServiceContext): Promise<json.LanguageSettings>;
	getDocumentLanguageSettings?(document: TextDocument, context: ServiceContext): Promise<json.DocumentLanguageSettings | undefined>;
	onDidChangeLanguageSettings?(listener: () => void, context: ServiceContext): Disposable;
} = {}): ServicePlugin {
	return {
		name: 'json',
		// https://github.com/microsoft/vscode/blob/09850876e652688fb142e2e19fd00fd38c0bc4ba/extensions/json-language-features/server/src/jsonServer.ts#L150
		triggerCharacters: ['"', ':'],
		create(context): ServicePluginInstance<Provide> {

			const jsonDocuments = new WeakMap<TextDocument, [number, json.JSONDocument]>();
			const jsonLs = json.getLanguageService({
				schemaRequestService: async (uri) => await context.env.fs?.readFile(uri) ?? '',
				workspaceContext: getWorkspaceContextService(context),
				clientCapabilities: context.env.clientCapabilities,
			});
			const disposable = onDidChangeLanguageSettings(() => initializing = undefined, context);

			let initializing: Promise<void> | undefined;

			return {

				dispose() {
					disposable.dispose();
				},

				provide: {
					'json/jsonDocument': getJsonDocument,
					'json/languageService': () => jsonLs,
				},

				provideCompletionItems(document, position) {
					return worker(document, async (jsonDocument) => {
						return await jsonLs.doComplete(document, position, jsonDocument);
					});
				},

				resolveCompletionItem(item) {
					return jsonLs.doResolve(item);
				},

				provideDefinition(document, position) {
					return worker(document, async (jsonDocument) => {
						return await jsonLs.findDefinition(document, position, jsonDocument);
					});
				},

				provideDiagnostics(document) {
					return worker(document, async (jsonDocument) => {
						const settings = await getDocumentLanguageSettings(document, context);
						return await jsonLs.doValidation(document, jsonDocument, settings);
					});
				},

				provideHover(document, position) {
					return worker(document, async (jsonDocument) => {
						return await jsonLs.doHover(document, position, jsonDocument);
					});
				},

				provideDocumentLinks(document) {
					return worker(document, async (jsonDocument) => {
						return await jsonLs.findLinks(document, jsonDocument);
					});
				},

				provideDocumentSymbols(document) {
					return worker(document, async (jsonDocument) => {
						return await jsonLs.findDocumentSymbols2(document, jsonDocument);
					});
				},

				provideDocumentColors(document) {
					return worker(document, async (jsonDocument) => {
						return await jsonLs.findDocumentColors(document, jsonDocument);
					});
				},

				provideColorPresentations(document, color, range) {
					return worker(document, async (jsonDocument) => {
						return await jsonLs.getColorPresentations(document, jsonDocument, color, range);
					});
				},

				provideFoldingRanges(document) {
					return worker(document, async () => {
						return await jsonLs.getFoldingRanges(document, context.env.clientCapabilities?.textDocument?.foldingRange);
					});
				},

				provideSelectionRanges(document, positions) {
					return worker(document, async (jsonDocument) => {
						return await jsonLs.getSelectionRanges(document, positions, jsonDocument);
					});
				},

				provideDocumentFormattingEdits(document, range, options) {
					return worker(document, async () => {

						if (!await isFormattingEnabled(document, context)) {
							return;
						}

						const formatOptions = await getFormattingOptions(document, context);

						return jsonLs.format(document, range, {
							...options,
							...formatOptions,
						});
					});
				},
			};

			async function worker<T>(document: TextDocument, callback: (jsonDocument: json.JSONDocument) => T): Promise<Awaited<T> | undefined> {

				const jsonDocument = getJsonDocument(document);
				if (!jsonDocument)
					return;

				await (initializing ??= initialize());

				return await callback(jsonDocument);
			}

			async function initialize() {
				const settings = await getLanguageSettings(context);
				jsonLs.configure(settings);
			}

			function getJsonDocument(textDocument: TextDocument) {

				if (!matchDocument(documentSelector, textDocument)) {
					return;
				}

				const cache = jsonDocuments.get(textDocument);
				if (cache) {
					const [cacheVersion, cacheDoc] = cache;
					if (cacheVersion === textDocument.version) {
						return cacheDoc;
					}
				}

				const doc = jsonLs.parseJSONDocument(textDocument);
				jsonDocuments.set(textDocument, [textDocument.version, doc]);

				return doc;
			}
		},
	};
}

function matchDocument(selector: DocumentSelector, document: TextDocument) {
	for (const sel of selector) {
		if (sel === document.languageId || (typeof sel === 'object' && sel.language === document.languageId)) {
			return true;
		}
	}
	return false;
}
