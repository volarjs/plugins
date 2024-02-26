import { ServicePluginInstance, forEachEmbeddedCode, type FileChangeType, type FileType, type LocationLink, type ServicePlugin, ServiceContext, DocumentSelector } from '@volar/language-service';
import { Emitter } from 'vscode-jsonrpc';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { DiagnosticOptions, ILogger, IMdLanguageService, IMdParser, IWorkspace } from 'vscode-markdown-languageservice';
import { LogLevel, createLanguageService, githubSlugifier } from 'vscode-markdown-languageservice';
import { URI } from 'vscode-uri';
import MarkdownIt = require('markdown-it');

export interface Provide {
	'markdown/languageService': () => IMdLanguageService;
}

const md = new MarkdownIt();

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

export function create({
	documentSelector = ['markdown'],
	getDiagnosticOptions = async (_document, context) => {
		return await context.env.getConfiguration?.('markdown.validate');
	},
}: {
	documentSelector?: DocumentSelector;
	getDiagnosticOptions?(document: TextDocument, context: ServiceContext): Promise<DiagnosticOptions | undefined>;
} = {}): ServicePlugin {
	return {
		name: 'markdown',
		triggerCharacters: ['.', '/', '#'],
		create(context): ServicePluginInstance<Provide> {

			let lastProjectVersion: string | undefined;

			const { fs, onDidChangeWatchedFiles } = context.env;
			assert(fs, 'context.env.fs must be defined');
			assert(
				onDidChangeWatchedFiles,
				'context.env.fs.onDidChangeWatchedFiles must be defined'
			);

			const logger: ILogger = {
				level: LogLevel.Off,

				log(_logLevel, message) {
					context.env.console?.log(message);
				}
			};

			const parser: IMdParser = {
				slugifier: githubSlugifier,

				async tokenize(document) {
					return md.parse(document.getText(), {});
				}
			};

			const onDidChangeMarkdownDocument = new Emitter<TextDocument>();
			const onDidCreateMarkdownDocument = new Emitter<TextDocument>();
			const onDidDeleteMarkdownDocument = new Emitter<URI>();

			const fileWatcher = onDidChangeWatchedFiles((event) => {
				for (const change of event.changes) {
					switch (change.type) {
						case 2 satisfies typeof FileChangeType.Changed: {
							const document = getTextDocument(change.uri, false);
							if (document) {
								onDidChangeMarkdownDocument.fire(document);
							}
							break;
						}
						case 1 satisfies typeof FileChangeType.Created: {
							const document = getTextDocument(change.uri, false);
							if (document) {
								onDidCreateMarkdownDocument.fire(document);
							}
							break;
						}
						case 3 satisfies typeof FileChangeType.Deleted: {
							onDidDeleteMarkdownDocument.fire(URI.parse(change.uri));
							break;
						}
					}
				}
			});

			const workspace: IWorkspace = {
				async getAllMarkdownDocuments() {
					sync();
					return syncedVersions.values();
				},

				getContainingDocument() {
					return undefined;
				},

				hasMarkdownDocument(resource) {
					const document = getTextDocument(resource.toString(), true);
					return Boolean(document && matchDocument(documentSelector, document));
				},

				onDidChangeMarkdownDocument: onDidChangeMarkdownDocument.event,

				onDidCreateMarkdownDocument: onDidCreateMarkdownDocument.event,

				onDidDeleteMarkdownDocument: onDidDeleteMarkdownDocument.event,

				async openMarkdownDocument(resource) {
					return getTextDocument(resource.toString(), true);
				},

				async readDirectory(resource) {
					const directory = await fs.readDirectory(resource.toString());
					return directory.map(([fileName, fileType]) => [
						fileName,
						{ isDirectory: fileType === 2 satisfies FileType.Directory }
					]);
				},

				async stat(resource) {
					const stat = await fs.stat(resource.toString());
					if (stat) {
						return { isDirectory: stat.type === 2 satisfies FileType.Directory };
					}
				},

				workspaceFolders: [URI.parse(context.env.workspaceFolder)],
			};

			const ls = createLanguageService({
				logger,
				parser,
				workspace
			});

			const syncedVersions = new Map<string, TextDocument>();

			const sync = () => {

				if (!context.language.typescript) {
					return;
				}

				const { languageServiceHost } = context.language.typescript;
				const newProjectVersion = languageServiceHost.getProjectVersion?.();
				const shouldUpdate = newProjectVersion === undefined || newProjectVersion !== lastProjectVersion;
				if (!shouldUpdate) {
					return;
				}
				lastProjectVersion = newProjectVersion;

				const oldVersions = new Set(syncedVersions.keys());
				const newVersions = new Map<string, TextDocument>();

				for (const fileName of languageServiceHost.getScriptFileNames()) {
					const uri = context.env.typescript!.fileNameToUri(fileName);
					const [_, sourceFile] = context.documents.getVirtualCodeByUri(uri);
					if (sourceFile?.generated) {
						for (const virtualCode of forEachEmbeddedCode(sourceFile.generated.code)) {
							if (matchDocument(documentSelector, virtualCode)) {
								const uri = context.documents.getVirtualCodeUri(sourceFile.id, virtualCode.id);
								const document = context.documents.get(uri, virtualCode.languageId, virtualCode.snapshot);
								newVersions.set(document.uri, document);
							}
						}
					}
					else if (sourceFile) {
						const document = context.documents.get(fileName, sourceFile.languageId, sourceFile.snapshot);
						if (document && matchDocument(documentSelector, document)) {
							newVersions.set(document.uri, document);
						}
					}
				}

				for (const [uri, document] of Array.from(newVersions)) {
					const old = syncedVersions.get(uri);
					syncedVersions.set(uri, document);
					if (old) {
						onDidChangeMarkdownDocument.fire(document);
					} else {
						onDidCreateMarkdownDocument.fire(document);
					}
				}

				for (const uri of Array.from(oldVersions)) {
					if (!newVersions.has(uri)) {
						syncedVersions.delete(uri);
						onDidDeleteMarkdownDocument.fire(URI.parse(uri));
					}
				}
			};
			const prepare = (document: TextDocument) => {
				if (!matchDocument(documentSelector, document)) {
					return false;
				}
				sync();
				return true;
			};

			return {
				dispose() {
					ls.dispose();
					fileWatcher.dispose();
					onDidDeleteMarkdownDocument.dispose();
					onDidCreateMarkdownDocument.dispose();
					onDidChangeMarkdownDocument.dispose();
				},

				provide: {
					'markdown/languageService': () => ls
				},

				provideCodeActions(document, range, context, token) {
					if (prepare(document)) {
						return ls.getCodeActions(document, range, context, token);
					}
				},

				async provideCompletionItems(document, position, _context, token) {
					if (prepare(document)) {
						const items = await ls.getCompletionItems(
							document,
							position,
							{},
							token
						);
						return {
							isIncomplete: false,
							items
						};
					}
				},

				async provideDefinition(document, position, token) {
					if (prepare(document)) {
						let locations = await ls.getDefinition(document, position, token);

						if (!locations) {
							return;
						}

						if (!Array.isArray(locations)) {
							locations = [locations];
						}

						return locations.map<LocationLink>(location => ({
							targetUri: location.uri,
							targetRange: location.range,
							targetSelectionRange: location.range,
						}));
					}
				},

				async provideDiagnostics(document, token) {
					if (prepare(document)) {
						const configuration = await getDiagnosticOptions(document, context);
						if (configuration) {
							return ls.computeDiagnostics(document, configuration, token);
						}
					}
				},

				provideDocumentHighlights(document, position, token) {
					if (prepare(document)) {
						return ls.getDocumentHighlights(document, position, token);
					}
				},

				provideDocumentLinks(document, token) {
					if (prepare(document)) {
						return ls.getDocumentLinks(document, token);
					}
				},

				provideDocumentSymbols(document, token) {
					if (prepare(document)) {
						return ls.getDocumentSymbols(
							document,
							{ includeLinkDefinitions: true },
							token
						);
					}
				},

				provideFileReferences(document, token) {
					if (prepare(document)) {
						return ls.getFileReferences(URI.parse(document.uri), token);
					}
				},

				provideFoldingRanges(document, token) {
					if (prepare(document)) {
						return ls.getFoldingRanges(document, token);
					}
				},

				provideReferences(document, position, referenceContext, token) {
					if (prepare(document)) {
						return ls.getReferences(
							document,
							position,
							referenceContext,
							token
						);
					}
				},

				provideRenameEdits(document, position, newName, token) {
					if (prepare(document)) {
						return ls.getRenameEdit(document, position, newName, token);
					}
				},

				provideRenameRange(document, position, token) {
					if (prepare(document)) {
						return ls.prepareRename(document, position, token);
					}
				},

				provideSelectionRanges(document, positions, token) {
					if (prepare(document)) {
						return ls.getSelectionRanges(document, positions, token);
					}
				},

				provideWorkspaceSymbols(query, token) {
					sync();
					return ls.getWorkspaceSymbols(query, token);
				},

				async resolveDocumentLink(link, token) {
					const result = await ls.resolveDocumentLink(link, token);

					return result || link;
				}
			};

			function getTextDocument(uri: string, includeVirtualFile: boolean) {
				if (includeVirtualFile) {
					const virtualCode = context.documents.getVirtualCodeByUri(uri)[0];
					if (virtualCode) {
						return context.documents.get(uri, virtualCode.languageId, virtualCode.snapshot);
					}
				}
				const sourceFile = context.language.files.get(uri);
				if (sourceFile) {
					return context.documents.get(uri, sourceFile.languageId, sourceFile.snapshot);
				}
			}
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
