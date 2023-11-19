import type { FileChangeType, FileType, Service } from '@volar/language-service';
import { Emitter } from 'vscode-jsonrpc';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ILogger, IMdLanguageService, IMdParser, IWorkspace } from 'vscode-markdown-languageservice';
import { DiagnosticLevel, LogLevel, createLanguageService, githubSlugifier } from 'vscode-markdown-languageservice';
import { URI } from 'vscode-uri';
import MarkdownIt = require('markdown-it');

export interface Provide {
	'markdown/languageService': () => IMdLanguageService;
}

const md = new MarkdownIt();

function isMarkdown(document: TextDocument): boolean {
	return document.languageId === 'markdown';
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

export function create(): Service<Provide> {
	return (context) => {
		if (!context) {
			return {} as any;
		}

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
				return Boolean(document && isMarkdown(document));
			},

			onDidChangeMarkdownDocument: onDidChangeMarkdownDocument.event,

			onDidCreateMarkdownDocument: onDidCreateMarkdownDocument.event,

			onDidDeleteMarkdownDocument: onDidDeleteMarkdownDocument.event,

			async openMarkdownDocument(resource) {
				return getTextDocument(resource.toString(), true);
			},

			async readDirectory(resource) {
				const directory = await fs.readDirectory(String(resource));
				return directory.map(([fileName, fileType]) => [
					fileName,
					{ isDirectory: fileType === 2 satisfies FileType.Directory }
				]);
			},

			async stat(resource) {
				const stat = await fs.stat(String(resource));
				if (stat) {
					return { isDirectory: stat.type === 2 satisfies FileType.Directory };
				}
			},

			workspaceFolders: []
		};

		const ls = createLanguageService({
			logger,
			parser,
			workspace
		});

		const syncedVersions = new Map<string, TextDocument>();

		const sync = () => {
			const newProjectVersion = context.project.typescript?.projectHost.getProjectVersion?.();
			const shouldUpdate = newProjectVersion === undefined || newProjectVersion !== lastProjectVersion;
			if (!shouldUpdate) {
				return;
			}
			lastProjectVersion = newProjectVersion;

			const oldVersions = new Set(syncedVersions.keys());
			const newVersions = new Map<string, TextDocument>();

			for (const sourceFile of context.project.fileProvider.getAllSourceFiles()) {
				if (sourceFile.root) {
					const virtualFiles = [sourceFile.root];
					sourceFile.root.embeddedFiles.forEach(function walk(embedded) {
						virtualFiles.push(embedded);
						embedded.embeddedFiles.forEach(walk);
					});
					for (const embedded of virtualFiles) {
						if (embedded.languageId === 'markdown') {
							const document = context.documents.get(embedded.id, embedded.languageId, embedded.snapshot);
							newVersions.set(document.uri, document);
						}
					}
				}
				else {
					const document = context.documents.get(sourceFile.id, sourceFile.languageId, sourceFile.snapshot);
					if (document && isMarkdown(document)) {
						newVersions.set(document.uri, document);
					}
				}
			}

			for (const [uri, document] of newVersions) {
				const old = syncedVersions.get(uri);
				syncedVersions.set(uri, document);
				if (old) {
					onDidChangeMarkdownDocument.fire(document);
				} else {
					onDidCreateMarkdownDocument.fire(document);
				}
			}

			for (const uri of oldVersions) {
				if (!newVersions.has(uri)) {
					syncedVersions.delete(uri);
					onDidDeleteMarkdownDocument.fire(URI.parse(uri));
				}
			}
		};
		const prepare = (document: TextDocument) => {
			if (!isMarkdown(document)) {
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

			provideDiagnostics(document, token) {
				if (prepare(document)) {
					return ls.computeDiagnostics(
						document,
						{
							ignoreLinks: [],
							validateDuplicateLinkDefinitions: DiagnosticLevel.warning,
							validateFileLinks: DiagnosticLevel.warning,
							validateFragmentLinks: DiagnosticLevel.warning,
							validateMarkdownFileLinkFragments: DiagnosticLevel.warning,
							validateReferences: DiagnosticLevel.warning,
							validateUnusedLinkDefinitions: DiagnosticLevel.warning
						},
						token
					);
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

			provideReferences(document, position, token) {
				if (prepare(document)) {
					return ls.getReferences(
						document,
						position,
						{ includeDeclaration: true },
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
			const file = (includeVirtualFile ? context!.project.fileProvider.getVirtualFile(uri)[0] : undefined)
				?? context!.project.fileProvider.getSourceFile(uri);
			if (file) {
				return context!.documents.get(uri, file.languageId, file.snapshot);
			}
		}
	};
}

export default create;
