import type { LanguageServicePlugin, LanguageServicePluginInstance, SemanticToken } from '@volar/language-service';
import * as fs from 'fs';
import * as path from 'path';
import * as vls from 'vls';
import type { TextDocument } from 'vscode-html-languageservice';
import * as html from 'vscode-html-languageservice';
import { URI } from 'vscode-uri';
import { getGlobalSnippetDir } from './lib/userSnippetDir';

export function create(): LanguageServicePlugin {
	return {
		name: 'vetur',
		capabilities: {
			completionProvider: {
				// https://github.com/microsoft/vscode/blob/09850876e652688fb142e2e19fd00fd38c0bc4ba/extensions/html-language-features/server/src/htmlServer.ts#L183
				triggerCharacters: ['.', ':', '<', '"', '=', '/', /* vue event shorthand */'@'],
			},
			hoverProvider: true,
			semanticTokensProvider: {
				legend: {
					tokenTypes: ['function'],
					tokenModifiers: [],
				},
			},
		},
		create(): LanguageServicePluginInstance {

			const htmlDocuments = new WeakMap<TextDocument, html.HTMLDocument>();
			const uriToPackageJsonPath = new Map<string, string | undefined>();
			const htmlDataProviders = new Map<string, html.IHTMLDataProvider[]>();
			const htmlLs = html.getLanguageService();
			const snippetManager = new vls.SnippetManager(getSnippetsPath() ?? ''/* TODO: find snippets folder from document path */, getGlobalSnippetDir(false));
			const scaffoldSnippetSources: vls.ScaffoldSnippetSources = {
				workspace: '💼',
				user: '🗒️',
				vetur: '✌'
			};

			return {

				isAdditionalCompletion: true,

				provideCompletionItems(document, position, context) {

					let result: html.CompletionList | undefined;

					htmlWorker(document, htmlDocument => {
						result = htmlLs.doComplete(document, position, htmlDocument);
					});

					if (!context.triggerCharacter) {
						vueWorker(document, () => {
							const items = snippetManager.completeSnippets(scaffoldSnippetSources);
							if (items.length) {
								result = {
									isIncomplete: false,
									items: items,
								};
							}
						});
					}

					return result;
				},

				provideHover(document, position) {
					return htmlWorker(document, htmlDocument => {
						return htmlLs.doHover(document, position, htmlDocument);
					});
				},

				provideDocumentSemanticTokens(document, range, legend) {
					return htmlWorker(document, () => {

						const packageJsonPath = getPackageJsonPath(document);
						if (!packageJsonPath) {
							return;
						}

						const dtmlDataProviders = getHtmlDataProviders(packageJsonPath);
						const components = new Set(dtmlDataProviders.map(provider => provider.getId() === 'html5' ? [] : provider.provideTags().map(tag => tag.name)).flat());
						const offsetRange = {
							start: document.offsetAt(range.start),
							end: document.offsetAt(range.end),
						};
						const scanner = htmlLs.createScanner(document.getText());
						const result: SemanticToken[] = [];

						let token = scanner.scan();

						while (token !== html.TokenType.EOS) {

							const tokenOffset = scanner.getTokenOffset();

							// TODO: fix source map perf and break in while condition
							if (tokenOffset > offsetRange.end) {
								break;
							}

							if (tokenOffset >= offsetRange.start && (token === html.TokenType.StartTag || token === html.TokenType.EndTag)) {

								const tokenText = scanner.getTokenText();

								if (components.has(tokenText) || tokenText.indexOf('.') >= 0) {

									const tokenLength = scanner.getTokenLength();
									const tokenPosition = document.positionAt(tokenOffset);

									if (components.has(tokenText)) {
										result.push([tokenPosition.line, tokenPosition.character, tokenLength, legend.tokenTypes.indexOf('function'), 0]);
									}
								}
							}
							token = scanner.scan();
						}

						return result;
					});
				},
			};

			function htmlWorker<T>(document: TextDocument, callback: (htmlDocument: html.HTMLDocument) => T) {

				const htmlDocument = getHtmlDocument(document);
				if (!htmlDocument) {
					return;
				}

				const packageJsonPath = getPackageJsonPath(document);
				if (!packageJsonPath) {
					return;
				}

				htmlLs.setDataProviders(
					false,
					getHtmlDataProviders(packageJsonPath),
				);

				return callback(htmlDocument);
			}

			function vueWorker<T>(document: TextDocument, callback: () => T) {
				if (document.languageId === 'vue') {
					return callback();
				}
			}

			function getPackageJsonPath(document: TextDocument) {

				let packageJsonPath = uriToPackageJsonPath.get(document.uri);

				if (!packageJsonPath) {

					const uri = URI.parse(document.uri);

					if (uri.scheme === 'file') {

						let lastDirname = uri.fsPath.replace(/\\/g, '/');

						while (true) {

							const dirname = path.dirname(lastDirname);
							if (dirname === lastDirname) {
								break;
							}

							if (fs.existsSync(dirname + '/package.json')) {
								packageJsonPath = dirname + '/package.json';
								break;
							}

							lastDirname = dirname;
						}
					}

					uriToPackageJsonPath.set(document.uri, packageJsonPath);
				}

				return packageJsonPath;
			}

			function getSnippetsPath() {

				const fsPath = __filename;

				let lastDirname = fsPath;
				let snippetsPath: string | undefined;

				while (true) {

					const dirname = path.dirname(lastDirname);
					if (dirname === lastDirname) {
						break;
					}

					if (fs.existsSync(dirname + '/.vscode/vetur/snippets')) {
						snippetsPath = dirname + '/.vscode/vetur/snippets';
						break;
					}

					lastDirname = dirname;
				}

				return snippetsPath;
			}

			function getHtmlDataProviders(packageJsonPath: string) {

				let dataProviders = htmlDataProviders.get(packageJsonPath);

				if (!dataProviders) {

					const tagProviderSettings = vls.getTagProviderSettings(packageJsonPath);
					const enabledTagProviders = vls.getEnabledTagProviders(tagProviderSettings);

					dataProviders = enabledTagProviders.map(provider => {
						const htmlProvider: html.IHTMLDataProvider = {
							getId: provider.getId,
							isApplicable() {
								return true;
							},
							provideTags() {
								const tags: html.ITagData[] = [];
								provider.collectTags((tag, documentation) => {
									tags.push({
										name: tag,
										description: documentation,
										attributes: [],
									});
								});
								return tags;
							},
							provideAttributes(tag) {
								const attributes: html.IAttributeData[] = [];
								provider.collectAttributes(tag, (attribute, type, documentation) => {
									if (attribute.startsWith('v-') || attribute.startsWith('@')) {
										attributes.push({
											name: attribute,
											valueSet: type,
											description: documentation,
										});
									}
									else {
										attributes.push({
											name: 'v-bind:' + attribute,
											valueSet: type,
											description: documentation,
										});
										attributes.push({
											name: ':' + attribute,
											valueSet: type,
											description: documentation,
										});
										attributes.push({
											name: attribute,
											valueSet: type,
											description: documentation,
										});
									}
								});
								return attributes;
							},
							provideValues(tag, attribute) {
								const values: html.IValueData[] = [];
								provider.collectValues(tag, attribute, value => {
									values.push({
										name: value,
									});
								});
								return values;
							},
						};
						return htmlProvider;
					});

					htmlDataProviders.set(packageJsonPath, dataProviders);
				}

				return dataProviders;
			}

			function getHtmlDocument(document: TextDocument) {

				if (document.languageId !== 'html') {
					return;
				}

				let htmlDocument = htmlDocuments.get(document);

				if (!htmlDocument) {
					htmlDocument = htmlLs.parseHTMLDocument(document);
					htmlDocuments.set(document, htmlDocument);
				}

				return htmlDocument;
			}
		},
	};
}
