import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { selectFile, getRootUri, changeSvgImg } from "./util";
import { readKmPngJson, writeKmPngJson } from './kmPng';
const xmindparser = require('./xmindparser');
let parser = new xmindparser()

const { Resvg, initWasm } = require('./wasm')
const wasmPath = path.join(__dirname, '../webui/resvg-js/index_bg.wasm')
const fontPath = path.join(__dirname, '../webui/resvg-js/fonts/Alibaba_PuHuiTi_2.0_45_Light_45_Light.ttf')

type MindMapFileType = '.xmind' | '.km' | '.svg' | '.km.png' | '';
const ExportType = {
	Xmind: 'xmind',
	Png: 'png',
	KmPng: 'km-png',
	Json: 'json',
} as const;
type ExportType = typeof ExportType[keyof typeof ExportType];
const viewType = 'vscode-mindmap.editor';
const INTERNAL_WRITE_SIGNATURE_TTL_MS = 3000;

type InternalWriteSignature = {
	signature: string;
	expiresAt: number;
};

type KmPngMessageContent = {
	json: string;
	svg: string;
};

type SaveDocumentMessage = {
	command: 'save';
	exportData: string;
	svgData?: string;
	documentVersion?: number;
};

type DraftDocumentMessage = {
	command: 'draft';
	exportData: string;
	svgData?: string;
	documentVersion?: number;
};

type UpdateDocumentMessage = SaveDocumentMessage | DraftDocumentMessage;

type ExportDocumentMessage = {
	command: 'export';
	type: string;
	filename?: string;
	content: string | KmPngMessageContent;
};

type WebviewMessage =
	| { command: 'loaded' }
	| SaveDocumentMessage
	| DraftDocumentMessage
	| { command: 'clicklink'; link: string }
	| { command: 'hideApplication' }
	| { command: 'errormsg'; content: string }
	| { command: 'importFile' }
	| ExportDocumentMessage;

let resvgResourcesPromise: Promise<{ fontBuffer: Buffer }> | undefined;

function getMindMapFileType(filePath: string): MindMapFileType {
	const normalizedPath = filePath.toLowerCase();
	if (normalizedPath.endsWith('.km.png')) {
		return '.km.png';
	}
	const extName = path.extname(normalizedPath);
	if (extName == '.xmind' || extName == '.km' || extName == '.svg') {
		return extName;
	}
	return '';
}

function getExportExtension(type: string): string {
	return type == ExportType.KmPng ? 'km.png' : type;
}

function normalizeMindJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(normalizeMindJsonValue);
	}
	if (value && typeof value === 'object') {
		const normalized: Record<string, unknown> = {};
		Object.keys(value as Record<string, unknown>)
			.sort()
			.forEach((key) => {
				normalized[key] = normalizeMindJsonValue((value as Record<string, unknown>)[key]);
			});
		return normalized;
	}
	return value;
}

function normalizeMindJsonData(data: unknown): string {
	const serialized = JSON.stringify(data ?? {});
	return JSON.stringify(normalizeMindJsonValue(JSON.parse(serialized || '{}')));
}

function normalizeMindJsonContent(content: string): string {
	return normalizeMindJsonData(JSON.parse(content || '{}'));
}

function getResvgResources(): Promise<{ fontBuffer: Buffer }> {
	if (!resvgResourcesPromise) {
		resvgResourcesPromise = loadResvgResources().catch((error) => {
			resvgResourcesPromise = undefined;
			throw error;
		});
	}
	return resvgResourcesPromise;
}

async function loadResvgResources(): Promise<{ fontBuffer: Buffer }> {
	const [wasmBuffer, fontBuffer] = await Promise.all([
		fs.promises.readFile(wasmPath),
		fs.promises.readFile(path.resolve(fontPath)),
	]);
	await initWasm(wasmBuffer);
	return { fontBuffer };
}

export class MindEditorProvider implements vscode.CustomEditorProvider {
	private readonly _activeDocumentWrites = new Map<string, number>();
	private readonly _lastInternalWriteSignatures = new Map<string, InternalWriteSignature>();
	private readonly _documentWriteQueues = new Map<string, Promise<void>>();
	private readonly _lastWrittenDocumentVersions = new Map<string, number>();
	private readonly _blockedKmPngWrites = new Set<string>();
	private readonly _shownKmPngMessages = new Set<string>();

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
		const htmlPath = process.platform === 'win32' ? onDiskPath.path.slice(1) : onDiskPath.path;
		const fileContent = await fs.promises.readFile(htmlPath, 'utf-8');

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
		const extName = getMindMapFileType(fileName);
		if (!extName) {
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
			async (message: WebviewMessage) => {
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
							vscode.window.showErrorMessage('save error!');
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
					case 'hideApplication':
						this.hideApplication();
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
								const content = await fs.promises.readFile(importFileUri.fsPath, 'utf-8')
								panel.webview.postMessage({
									command: 'importNewData',
									content,
									basename,
								});
							}
						}

						break;
					case 'export':
						try {
							await this.exportDocument(message);
						} catch (ex) {
							console.error(ex);
							vscode.window.showErrorMessage('export error!');
						}
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
				this._documentWriteQueues.delete(fileName);
				this._lastWrittenDocumentVersions.delete(fileName);
				this._blockedKmPngWrites.delete(fileName);
				this.clearKmPngMessages(fileName);
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

	private notifyExternalExtensions(message: { type: 'clicklink'; from: 'mindmap'; link: string }) {
		this.extensionChannels.forEach((chanel) => {
			chanel.postMessage(message);
		});
	}

	private hideApplication() {
		if (process.platform !== 'darwin') {
			return;
		}

		const appName = vscode.env.appName || 'Visual Studio Code';
		const scripts = [
			'tell application id "com.microsoft.VSCode" to hide',
			`tell application ${this.toAppleScriptString(appName)} to hide`,
			'tell application "System Events" to set visible of first application process whose frontmost is true to false',
		];

		this.runAppleScript(scripts);
	}

	private runAppleScript(scripts: string[], index = 0) {
		childProcess.execFile(
			'/usr/bin/osascript',
			['-e', scripts[index]],
			{ timeout: 2000 },
			(error) => {
				if (error) {
					if (index + 1 < scripts.length) {
						this.runAppleScript(scripts, index + 1);
						return;
					}
					console.error(error);
				}
			}
		);
	}

	private toAppleScriptString(value: string) {
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}

	private async exportDocument(message: ExportDocumentMessage): Promise<void> {
		const rootUri = getRootUri();
		if (!rootUri) {
			return;
		}

		const exportExtension = getExportExtension(message.type);
		const exportFilename = message.filename || 'mindmap';
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(path.join(rootUri.fsPath, `${exportFilename}.${exportExtension}`)),
			filters: this.getExportFilters(message.type)
		});
		if (!uri) {
			return;
		}

		const filePath = uri.fsPath;
		if (message.type == ExportType.Xmind) {
			if (typeof message.content !== 'string') {
				throw new Error('Invalid xmind export content.');
			}
			let data = JSON.parse(message.content)
			//脑图 json转xmind 浏览器返回blob node返回pathurl
			await parser.JSONToXmind(data, filePath)
		} else if (message.type == ExportType.Png) {
			if (typeof message.content !== 'string') {
				throw new Error('Invalid png export content.');
			}
			const pngBuffer = await this.renderSvgToPngBuffer(message.content);
			await fs.promises.writeFile(filePath, pngBuffer)
		} else if (message.type == ExportType.KmPng) {
			const content = this.getKmPngMessageContent(message.content);
			await this.writeKmPngDocument(filePath, content.json, content.svg)
		} else if (message.type == ExportType.Json) {
			if (typeof message.content !== 'string') {
				throw new Error('Invalid json export content.');
			}
			//格式化json
			await fs.promises.writeFile(filePath, JSON.stringify(JSON.parse(message.content), null, "\t"), 'utf-8')
		} else {
			if (typeof message.content !== 'string') {
				throw new Error('Invalid export content.');
			}
			await fs.promises.writeFile(filePath, message.content, 'utf-8')
		}
	}

	private getExportFilters(type: string): { [name: string]: string[] } {
		let filters: { [name: string]: string[] } = { 'All Files': ['*'] }
		if (type == ExportType.Xmind) {
			filters['Text Files'] = ['xmind']
		} else if (type == ExportType.Png) {
			filters['Images Files'] = ['png']
		} else if (type == ExportType.KmPng) {
			filters['Editable MindMap PNG'] = ['km.png']
			filters['Images Files'] = ['png']
		}
		return filters;
	}

	private getKmPngMessageContent(content: unknown): KmPngMessageContent {
		const maybeContent = content as Partial<KmPngMessageContent> | undefined;
		if (!maybeContent || typeof maybeContent.json !== 'string' || typeof maybeContent.svg !== 'string') {
			throw new Error('Invalid km.png export content.');
		}
		return {
			json: maybeContent.json,
			svg: maybeContent.svg,
		};
	}

	private async writeKmPngDocument(filePath: string, jsonContent: string, svgContent: string): Promise<void> {
		JSON.parse(jsonContent);
		const pngBuffer = await this.renderSvgToPngBuffer(svgContent);
		await fs.promises.writeFile(filePath, await writeKmPngJson(pngBuffer, jsonContent))
	}

	private async renderSvgToPngBuffer(svgContent: string): Promise<Buffer> {
		let new_svg = await changeSvgImg(svgContent)
		if (!new_svg) {
			throw new Error('Failed to convert SVG before PNG export.');
		}

		const mindmapConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("MindMap")
		const imageBackgroundColor = mindmapConfig.get<string>('imageBackgroundColor', '#ffffff');
		const imageScaleSize = mindmapConfig.get<number>('imageScaleSize', 2);
		const { fontBuffer } = await getResvgResources();

		const opts = {
			background: imageBackgroundColor,
			fitTo: {
				mode: 'zoom',
				value: imageScaleSize,
			},
			font: {
				fontBuffers: [fontBuffer],
				// fontFiles: [font], // Load custom fonts.
				loadSystemFonts: false, // It will be faster to disable loading system fonts.
				// defaultFontFamily: 'Source Han Serif CN Light',
			},
		}
		const resvg = new Resvg(new_svg, opts)
		const pngData = resvg.render()
		const pngBuffer = pngData.asPng()
		return Buffer.from(pngBuffer);
	}

	private updateDocument(
		document: vscode.CustomDocument,
		message: UpdateDocumentMessage
	): Thenable<void> {
		const filePath = document.uri.fsPath;
		const previousWrite = this._documentWriteQueues.get(filePath) || Promise.resolve();
		const queuedWrite = previousWrite
			.catch(() => undefined)
			.then(async () => {
				if (this.shouldSkipStaleDraft(filePath, message)) {
					return;
				}
				if (await this.shouldSkipUnchangedWrite(filePath, message)) {
					this.rememberWrittenDocumentVersion(filePath, message);
					return;
				}

				this.beginInternalWrite(filePath);
				try {
					await this.writeDocument(filePath, message);
					this.rememberInternalWrite(filePath);
					this.rememberWrittenDocumentVersion(filePath, message);
				} finally {
					this.endInternalWrite(filePath);
				}
			});

		this._documentWriteQueues.set(filePath, queuedWrite);
		const cleanupWriteQueue = () => {
			if (this._documentWriteQueues.get(filePath) === queuedWrite) {
				this._documentWriteQueues.delete(filePath);
			}
		};
		queuedWrite.then(cleanupWriteQueue, cleanupWriteQueue);
		return queuedWrite;
	}

	private async shouldSkipUnchangedWrite(
		filePath: string,
		message: UpdateDocumentMessage
	): Promise<boolean> {
		const extName = getMindMapFileType(filePath);
		try {
			const nextContent = normalizeMindJsonContent(message.exportData);
			if (extName == '.km') {
				const currentContent = await fs.promises.readFile(filePath, 'utf-8') || '{}';
				return normalizeMindJsonContent(currentContent) == nextContent;
			}
			if (extName == '.xmind') {
				const currentData = await parser.xmindToJSON(filePath);
				return normalizeMindJsonData(currentData) == nextContent;
			}
			if (extName == '.km.png') {
				if (this._blockedKmPngWrites.has(filePath)) {
					return false;
				}
				const currentContent = await this.getKmPngContent(filePath, true);
				return normalizeMindJsonContent(currentContent) == nextContent;
			}
		} catch (ex) {
			return false;
		}
		return false;
	}

	private async writeDocument(
		filePath: string,
		message: UpdateDocumentMessage
	): Promise<void> {
		const extName = getMindMapFileType(filePath);
		if (extName == '.xmind') {
			let data = JSON.parse(message.exportData)
			// json转xmind
			await parser.JSONToXmind(data, filePath)
		} else if (extName == '.km.png') {
			if (this._blockedKmPngWrites.has(filePath)) {
				throw new Error('Current km.png has unreadable mindmap data. Refusing to overwrite it.');
			}
			if (!message.svgData) {
				throw new Error('Missing SVG data for km.png.');
			}
			await this.writeKmPngDocument(filePath, message.exportData, message.svgData)
		} else {
			await fs.promises.writeFile(filePath, message.exportData)
		}
	}

	private shouldSkipStaleDraft(
		filePath: string,
		message: UpdateDocumentMessage
	): boolean {
		if (message.command !== 'draft' || typeof message.documentVersion !== 'number') {
			return false;
		}

		const lastWrittenDocumentVersion = this._lastWrittenDocumentVersions.get(filePath);
		return typeof lastWrittenDocumentVersion === 'number' && message.documentVersion <= lastWrittenDocumentVersion;
	}

	private rememberWrittenDocumentVersion(
		filePath: string,
		message: UpdateDocumentMessage
	) {
		if (typeof message.documentVersion !== 'number') {
			return;
		}
		const lastWrittenDocumentVersion = this._lastWrittenDocumentVersions.get(filePath);
		if (typeof lastWrittenDocumentVersion !== 'number' || message.documentVersion > lastWrittenDocumentVersion) {
			this._lastWrittenDocumentVersions.set(filePath, message.documentVersion);
		}
	}

	private shouldIgnoreFileChange(filePath: string): boolean {
		if ((this._activeDocumentWrites.get(filePath) || 0) > 0) {
			return true;
		}
		const lastInternalWriteSignature = this._lastInternalWriteSignatures.get(filePath);
		if (!lastInternalWriteSignature) {
			return false;
		}
		if (lastInternalWriteSignature.expiresAt < Date.now()) {
			this._lastInternalWriteSignatures.delete(filePath);
			return false;
		}
		const currentSignature = this.getFileSignature(filePath);
		if (currentSignature && currentSignature == lastInternalWriteSignature.signature) {
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
			this._lastInternalWriteSignatures.set(filePath, {
				signature,
				expiresAt: Date.now() + INTERNAL_WRITE_SIGNATURE_TTL_MS,
			});
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

	private async getKmPngContent(filePath: string, throwOnError: boolean): Promise<string> {
		const result = await readKmPngJson(filePath);
		if (result.kind == 'found') {
			try {
				JSON.parse(result.json);
				this._blockedKmPngWrites.delete(filePath);
				return result.json;
			} catch (error) {
				this._blockedKmPngWrites.add(filePath);
				if (throwOnError) {
					throw error;
				}
				this.showKmPngMessage(filePath, 'error', '当前 km.png 的脑图数据损坏，将以空脑图打开，但不会自动保存以避免覆盖原文件。');
				return '{}';
			}
		}
		if (result.kind == 'empty') {
			this._blockedKmPngWrites.delete(filePath);
			return '{}';
		}
		if (result.kind == 'missing') {
			this._blockedKmPngWrites.delete(filePath);
			this.showKmPngMessage(filePath, 'warning', '当前 PNG 不包含脑图数据，将以空脑图打开。编辑后会保存为可编辑 km.png。');
			return '{}';
		}
		if (result.kind == 'invalid') {
			this._blockedKmPngWrites.add(filePath);
			if (throwOnError) {
				throw new Error('Invalid km.png file.');
			}
			this.showKmPngMessage(filePath, 'error', '当前文件不是有效 PNG，无法读取脑图数据，也不会自动保存以避免覆盖原文件。');
			return '{}';
		}
		return '{}';
	}

	private showKmPngMessage(filePath: string, type: 'warning' | 'error', message: string) {
		const key = `${filePath}:${type}:${message}`;
		if (this._shownKmPngMessages.has(key)) {
			return;
		}
		this._shownKmPngMessages.add(key);
		if (type == 'warning') {
			vscode.window.showWarningMessage(message);
		} else {
			vscode.window.showErrorMessage(message);
		}
	}

	private clearKmPngMessages(filePath: string) {
		const prefix = `${filePath}:`;
		Array.from(this._shownKmPngMessages)
			.filter((key) => key.startsWith(prefix))
			.forEach((key) => this._shownKmPngMessages.delete(key));
	}

	private async getContent(document: vscode.CustomDocument, throwOnXmindError = false) {
		const extName = getMindMapFileType(document.uri.fsPath);
		let result = '';
		switch (extName) {
			case '.km':
				result = await fs.promises.readFile(document.uri.fsPath, 'utf-8') || '{}';
				break;
			case '.km.png':
				result = await this.getKmPngContent(document.uri.fsPath, throwOnXmindError);
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
