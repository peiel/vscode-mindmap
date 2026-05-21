import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { selectFile, getRootUri, changeSvgImg } from "./util";
const xmindparser = require('./xmindparser');
let parser = new xmindparser()

const { Resvg, initWasm } = require('./wasm')
const index_bg = fs.readFileSync(path.join(__dirname, '../webui/resvg-js/index_bg.wasm'))
initWasm(index_bg)
const fontPath = path.join(__dirname, '../webui/resvg-js/fonts/Alibaba_PuHuiTi_2.0_45_Light_45_Light.ttf')

const matchableFileTypes: string[] = ['xmind', 'km', 'svg'];
const viewType = 'vscode-mindmap.editor';

export class MindEditorProvider implements vscode.CustomEditorProvider {
	private readonly _activeDocumentWrites = new Map<string, number>();
	private readonly _lastInternalWriteSignatures = new Map<string, string>();

	constructor(public context: vscode.ExtensionContext) {
		this.context = context;
	}

	static register(context: vscode.ExtensionContext) {
		const provider = new MindEditorProvider(context);
		const providerRegistration = vscode.window.registerCustomEditorProvider(viewType, provider, {
			webviewOptions: {
				retainContextWhenHidden: true,
			},
			supportsMultipleEditorsPerDocument: false,
		});
		return providerRegistration;
	}

	revertCustomDocument(document: vscode.CustomDocument, cancellation: vscode.CancellationToken): Thenable<void> {
		throw new Error('Method not implemented.');
	}
	backupCustomDocument(document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
		throw new Error('Method not implemented.');
	}

	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
		vscode.CustomDocumentEditEvent
	>()
	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event

	saveCustomDocumentAs(document: vscode.CustomDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
		throw new Error('Method not implemented.');
	}

	public async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
		return {
			uri,
			dispose() { }
		};
	}

	public saveCustomDocument(document: vscode.CustomDocument): Thenable<void> {
		return Promise.resolve();
	}

	async resolveCustomEditor(
		document: vscode.CustomDocument,
		webviewPanel: vscode.WebviewPanel
	): Promise<void> {

		const onDiskPath = vscode.Uri.file(path.join(this.context.extensionPath, 'webui', 'mindmap.html'));
		const resourcePath = vscode.Uri.file(path.join(this.context.extensionPath, 'webui'));
		const resourceRealPath = webviewPanel.webview.asWebviewUri(resourcePath);
		const fileContent =
			process.platform === 'win32'
				? fs.readFileSync(onDiskPath.path.slice(1)).toString()
				: fs.readFileSync(onDiskPath.path).toString();

		// 生成 CSP meta 标签
		const cspSource = webviewPanel.webview.cspSource;
		const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data: blob:; script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource} data:; connect-src ${cspSource} https:; worker-src blob:;" />`;

		let html = fileContent.replace(/\$\{vscode\}/g, resourceRealPath.toString()).replace(/\$\{csp\}/g, csp);

		let mindmapConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("MindMap")
		const uploadUrl = mindmapConfig.get<string>('uploadUrl', '');
		const lang = mindmapConfig.get<string>('language') || vscode.env.language;
		//设置默认语言
		html = html.replace(/\$\{vscode_lang\}/g, lang);
		//设置上传地址
		html = html.replace(/\$\{vscode_upload_url\}/g, uploadUrl);

		const fileName = document.uri.fsPath;
		const extName = path.extname(fileName);
		if (!matchableFileTypes.includes(extName.slice(1))) {
			return;
		}
		const importData = await this.getContent(document);
		const panel = webviewPanel;
		const disposables: vscode.Disposable[] = [];
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'webui'))],
		};
		panel.webview.html = html;
		disposables.push(this.watchDocumentFile(document, panel, extName));
		panel.webview.onDidReceiveMessage(
			async (message: any) => {
				switch (message.command) {
					case 'loaded':
						panel.webview.postMessage({
							command: 'import',
							importData,
							extName,
						});
						return;
					case 'save':
						try {
							await this.updateDocument(document, message);
						} catch (ex) {
							console.error(ex);
						}
						return;
					case 'draft':
						try {
							await this.updateDocument(document, message);
						} catch (ex) {
							console.error(ex);
						}
						return;
					case 'clicklink':
						this.notifyExternalExtensions({
							type: 'clicklink',
							from: 'mindmap',
							link: message.link,
						});
						break;
					case 'errormsg':
						vscode.window.showErrorMessage(message.content)
						break;
					case 'importFile':
						// 选择文件
						const importFileUri = await selectFile({
							canSelectFiles: false,
							canSelectFolders: false,
							filters: {
								file: ['km', 'txt', 'md', 'json', 'xmind'],
							}
						});
						if (importFileUri) {
							let basename = path.extname(importFileUri.fsPath).toLowerCase()
							let fileType = ''
							switch (basename) {
								case '.md':
									fileType = 'markdown';
									break;
								case '.txt':
									fileType = 'text';
									break;
								case '.km':
								case '.json':
									fileType = 'json';
									break;
								case '.xmind':
									fileType = 'xmind';
									break;
								default:
									console.log("File not supported!");
									return;
							}

							if (fileType == 'xmind') {
								parser.xmindToJSON(importFileUri.fsPath).then((json: any) => {
									panel.webview.postMessage({
										command: 'importNewData',
										content: json,
										basename,
									});
								})
							} else {
								let content: any = fs.readFileSync(importFileUri.fsPath, 'utf-8')
								panel.webview.postMessage({
									command: 'importNewData',
									content,
									basename,
								});
							}
						}

						break;
					case 'export':
						let filters: any = { 'All Files': ['*'] }
						if (message.type == 'xmind') {
							filters['Text Files'] = ['xmind']
						} else if (message.type == 'png') {
							filters['Images Files'] = ['png']
						}

						// 弹出保存对话框
						const rootUri = getRootUri();
						rootUri && vscode.window.showSaveDialog({
							defaultUri: vscode.Uri.file(path.join(rootUri.fsPath, message.filename + '.' + message.type)), // 设置默认文件名
							filters: filters
						}).then(async uri => {
							if (uri) {
								// 处理用户选择的文件路径
								const filePath = uri.fsPath;
								if (message.type == 'xmind') {
									let data = JSON.parse(message.content)
									//脑图 json转xmind 浏览器返回blob node返回pathurl
									parser.JSONToXmind(data, filePath).then((data: any) => {
										console.log("data", data)
									})
								} else if (message.type == 'png') {
									let new_svg = await changeSvgImg(message.content)
									if (new_svg) {
										const imageBackgroundColor = mindmapConfig.get<string>('imageBackgroundColor', '#ffffff');
										const imageScaleSize = mindmapConfig.get<number>('imageScaleSize', 2);

										const sourceBuffer = fs.readFileSync(path.resolve(fontPath))
										const opts = {
											background: imageBackgroundColor,
											fitTo: {
												mode: 'zoom',
												value: imageScaleSize,
											},
											font: {
												fontBuffers: [sourceBuffer],
												// fontFiles: [font], // Load custom fonts.
												loadSystemFonts: false, // It will be faster to disable loading system fonts.
												// defaultFontFamily: 'Source Han Serif CN Light',
											},
										}
										const resvg = new Resvg(new_svg, opts)
										const pngData = resvg.render()
										const pngBuffer = pngData.asPng()
										await fs.writeFileSync(filePath, pngBuffer)
									}

									// sharp强大 但有系统兼容问题暂不采用
									// try {
									//     const sharp = require("sharp");
									//     let new_svg = await changeSvgImg(message.content)
									//     if (new_svg) {
									//         const sourceBuffer = Buffer.from(new_svg, 'utf-8');
									//         const imageScaleSize = mindmapConfig.get<number>('imageScaleSize', 200);
									//         const imageBackgroundColor = mindmapConfig.get<string>('imageBackgroundColor', '#ffffff');
									//         sharp(sourceBuffer, {
									//             density: imageScaleSize // 设置导出像素
									//         })
									//             .png({ quality: 90 })
									//             .flatten({ background: imageBackgroundColor })
									//             .toFile(filePath, (err: any, info: any) => {
									//                 if (err) {
									//                     return;
									//                 }
									//             });
									//     } else {
									//         vscode.window.showErrorMessage('export error!')
									//     }
									// } catch (error) {
									//     //降级处理有的操作系统不支持sharp 则导出普通图片
									// }
								} else if (message.type == 'json') {
									//格式化json
									fs.writeFileSync(filePath, JSON.stringify(JSON.parse(message.content), null, "\t"), 'utf-8')
								} else {
									fs.writeFileSync(filePath, message.content, 'utf-8')
								}
							}
						});
						break;
					default:
						break;
				}
			},
			undefined,
			disposables
		);

		panel.onDidDispose(
			() => {
				disposables.forEach(disposable => disposable.dispose());
				this._activeDocumentWrites.delete(fileName);
				this._lastInternalWriteSignatures.delete(fileName);
			},
			null,
			this.context.subscriptions
		);
	}

	private watchDocumentFile(
		document: vscode.CustomDocument,
		panel: vscode.WebviewPanel,
		extName: string
	): vscode.Disposable {
		const filePath = document.uri.fsPath;
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath)),
			false,
			false,
			true
		);
		let reloadTimer: ReturnType<typeof setTimeout> | undefined;

		const scheduleReload = () => {
			if (this.shouldIgnoreFileChange(filePath)) {
				return;
			}
			if (reloadTimer) {
				clearTimeout(reloadTimer);
			}
			reloadTimer = setTimeout(async () => {
				reloadTimer = undefined;
				if (this.shouldIgnoreFileChange(filePath)) {
					return;
				}
				try {
					await this.reloadDocumentFromDisk(document, panel, extName);
				} catch (ex) {
					console.error(ex);
				}
			}, 150);
		};

		const changeDisposable = watcher.onDidChange(scheduleReload);
		const createDisposable = watcher.onDidCreate(scheduleReload);

		return new vscode.Disposable(() => {
			if (reloadTimer) {
				clearTimeout(reloadTimer);
			}
			changeDisposable.dispose();
			createDisposable.dispose();
			watcher.dispose();
		});
	}

	private async reloadDocumentFromDisk(
		document: vscode.CustomDocument,
		panel: vscode.WebviewPanel,
		extName: string
	) {
		const importData = await this.getContentForReload(document);
		await panel.webview.postMessage({
			command: 'reload',
			importData,
			extName,
		});
	}

	private async getContentForReload(document: vscode.CustomDocument) {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.getContent(document, true);
			} catch (error) {
				lastError = error;
				await this.delay(100);
			}
		}
		throw lastError;
	}

	private delay(timeout: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, timeout));
	}

	private notifyExternalExtensions(message: any) {
		this.extensionChannels.forEach((chanel) => {
			chanel.postMessage(message);
		});
	}

	private updateDocument(
		document: vscode.CustomDocument,
		message: {
			command: string;
			exportData: string;
		}
	): Thenable<void> {
		const filePath = document.uri.fsPath;
		this.beginInternalWrite(filePath);
		return Promise.resolve().then(async () => {
			const extName = path.extname(filePath).toLowerCase();
			if (extName == '.xmind') {
				let data = JSON.parse(message.exportData)
				// json转xmind
				await parser.JSONToXmind(data, filePath)
			} else {
				fs.writeFileSync(filePath, message.exportData)
			}
			this.rememberInternalWrite(filePath);
		}).finally(() => {
			this.endInternalWrite(filePath);
		});
	}

	private shouldIgnoreFileChange(filePath: string): boolean {
		if ((this._activeDocumentWrites.get(filePath) || 0) > 0) {
			return true;
		}
		const lastInternalWriteSignature = this._lastInternalWriteSignatures.get(filePath);
		if (!lastInternalWriteSignature) {
			return false;
		}
		const currentSignature = this.getFileSignature(filePath);
		if (currentSignature && currentSignature == lastInternalWriteSignature) {
			return true;
		}
		this._lastInternalWriteSignatures.delete(filePath);
		return false;
	}

	private beginInternalWrite(filePath: string) {
		this._activeDocumentWrites.set(filePath, (this._activeDocumentWrites.get(filePath) || 0) + 1);
	}

	private endInternalWrite(filePath: string) {
		const activeWrites = (this._activeDocumentWrites.get(filePath) || 0) - 1;
		if (activeWrites > 0) {
			this._activeDocumentWrites.set(filePath, activeWrites);
		} else {
			this._activeDocumentWrites.delete(filePath);
		}
	}

	private rememberInternalWrite(filePath: string) {
		const signature = this.getFileSignature(filePath);
		if (signature) {
			this._lastInternalWriteSignatures.set(filePath, signature);
		}
	}

	private getFileSignature(filePath: string): string | undefined {
		try {
			const stat = fs.statSync(filePath);
			return `${stat.mtimeMs}:${stat.size}`;
		} catch (ex) {
			return undefined;
		}
	}

	private async getContent(document: vscode.CustomDocument, throwOnXmindError = false) {
		const extName = path.extname(document.uri.fsPath).toLowerCase();
		let result = '';
		switch (extName) {
			case '.km':
				result = fs.readFileSync(document.uri.fsPath, 'utf-8') || '{}';
				break;
			case '.xmind':
				try {
					let data = await parser.xmindToJSON(document.uri.fsPath)
					result = JSON.stringify(data) || '{}';
				} catch (error) {
					if (throwOnXmindError) {
						throw error;
					}
					result = '{}';
				}
				break;
			case '.svg':
				break;
			default:
				break;
		}
		return result
	}

	get extensionChannels() {
		return vscode.extensions.all
			.filter((ext) => ext.isActive && ext.exports && ext.exports.exportedMessageChannel)
			.map((ext) => ext.exports.exportedMessageChannel);
	}
}
