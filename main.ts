import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, Vault } from 'obsidian';
import axios from 'axios';

interface GyazoImage {
	image_id: string;
	permalink_url: string;
	thumb_url: string;
	url: string;
	type: string;
	created_at: string;
	metadata?: {
		app: string | null;
		title: string | null;
		url: string | null;
		desc: string | null;
	};
	ocr?: {
		locale: string;
		description: string;
	};
}

interface GyazoPluginSettings {
	clientId: string;
	saveDirectory: string;
	lastFetchedId: string;
	forceRefetch: boolean;
	fetchInterval: number; // 定期取得間隔（時間単位、0=定期取得しない）
	lastFetchTime: number; // 最後に取得した時間（タイムスタンプ）
	detectDeletedImages: boolean; // Gyazoで削除された画像を検知するかどうか
	deleteNotesForDeletedImages: boolean; // 削除された画像のノートも削除するかどうか
	maxImagesToFetch: number; // 一度に取得する最新画像の最大枚数
}

const DEFAULT_SETTINGS: GyazoPluginSettings = {
	clientId: '',
	saveDirectory: 'Gyazo',
	lastFetchedId: '',
	forceRefetch: false,
	fetchInterval: 0, // 初期値は0（定期取得しない）
	lastFetchTime: 0,
	detectDeletedImages: true, // 初期値はtrue（削除された画像を検知する）
	deleteNotesForDeletedImages: false, // 初期値はfalse（確認なしでは削除しない）
	maxImagesToFetch: 40 // 初期値は40枚（一度に取得する最大画像数）
}

// Gyazo画像削除確認用のModalクラス
class DeleteGyazoImageModal extends Modal {
	private imageId: string;
	private onConfirm: (deleteNote: boolean) => void;

	constructor(app: App, imageId: string, onConfirm: (deleteNote: boolean) => void) {
		super(app);
		this.imageId = imageId;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.empty();

		contentEl.createEl('h2', {text: 'Gyazo画像の削除'});
		contentEl.createEl('p', {text: `Gyazo画像(${this.imageId})を削除します。この操作は元に戻せません。`});
		contentEl.createEl('p', {text: 'ノートも一緒に削除しますか？'});

		const buttonContainer = contentEl.createDiv();
		buttonContainer.addClass('gyazo-delete-buttons');
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'space-between';
		buttonContainer.style.marginTop = '20px';

		const cancelButton = buttonContainer.createEl('button', {text: 'キャンセル'});
		cancelButton.style.marginRight = '10px';
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		const deleteImageOnlyButton = buttonContainer.createEl('button', {text: '画像のみ削除'});
		deleteImageOnlyButton.style.marginRight = '10px';
		deleteImageOnlyButton.addEventListener('click', () => {
			this.close();
			this.onConfirm(false);
		});

		const deleteAllButton = buttonContainer.createEl('button', {text: '画像とノートを削除'});
		deleteAllButton.addClass('mod-warning');
		deleteAllButton.addEventListener('click', () => {
			this.close();
			this.onConfirm(true);
		});
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

export default class GyazoPlugin extends Plugin {
	settings: GyazoPluginSettings;
	fetchTimer: NodeJS.Timeout | null = null; // 定期取得用のタイマー

	async onload() {
		await this.loadSettings();

		// リボンアイコンを追加
		const ribbonIconEl = this.addRibbonIcon('image', 'Gyazo画像取得', (evt: MouseEvent) => {
			this.fetchGyazoImages();
		});
		ribbonIconEl.addClass('gyazo-plugin-ribbon-class');

		// コマンドを追加
		this.addCommand({
			id: 'fetch-gyazo-images',
			name: 'Gyazo画像を取得',
			callback: () => {
				this.fetchGyazoImages();
			}
		});

		// Gyazo画像削除コマンドを追加
		this.addCommand({
			id: 'delete-gyazo-image',
			name: '現在のノートのGyazo画像を削除',
			checkCallback: (checking) => {
				// 現在開いているノートを取得
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					if (!checking) {
						this.deleteCurrentGyazoImage(activeView);
					}
					return true;
				}
				return false;
			}
		});

		// 設定タブを追加
		this.addSettingTab(new GyazoSettingTab(this.app, this));

		// 定期取得のタイマーを設定
		this.setupFetchTimer();
	}

	// 現在開いているノートのGyazo画像を削除するメソッド
	async deleteCurrentGyazoImage(view: MarkdownView) {
		const file = view.file;
		if (!file) {
			new Notice('ノートが開かれていません');
			return;
		}
		
		try {
			const content = await this.app.vault.read(file);
			
			// Gyazoノートかどうかを確認
			if (content.includes('gyazo_id:')) {
				// gyazo_idを抽出
				const match = content.match(/gyazo_id: ([a-zA-Z0-9]+)/);
				if (match && match[1]) {
					const imageId = match[1];
					
					// 確認ダイアログを表示
					const modal = new DeleteGyazoImageModal(this.app, imageId, async (deleteNote) => {
						try {
							// Gyazo APIで画像を削除
							const success = await this.deleteGyazoImage(imageId);
							
							if (success) {
								new Notice(`Gyazo画像 ${imageId} を削除しました`);
								
								// ノートも削除する場合
								if (deleteNote) {
									await this.app.vault.delete(file);
									new Notice('ノートを削除しました');
								}
							}
						} catch (error) {
							console.error('画像削除エラー:', error);
							new Notice('画像の削除に失敗しました');
						}
					});
					
					modal.open();
				} else {
					new Notice('Gyazo IDが見つかりません');
				}
			} else {
				new Notice('このノートはGyazoノートではありません');
			}
		} catch (error) {
			console.error('ノート読み込みエラー:', error);
			new Notice('ノートの読み込みに失敗しました');
		}
	}
	
	// Gyazo APIで画像を削除するメソッド
	async deleteGyazoImage(imageId: string): Promise<boolean> {
		try {
			// Gyazo APIを呼び出して画像を削除
			// client_idパラメータを使用して認証
			const response = await axios.delete(`https://api.gyazo.com/api/images/${imageId}`, {
				params: {
					access_token: this.settings.clientId
				}
			});
			
			// ステータスコードとレスポンスデータの両方を確認
			if (response.status === 200 && response.data && response.data.image_id === imageId) {
				console.log(`画像削除成功: ${imageId}、タイプ: ${response.data.type}`);
				return true;
			} else {
				console.warn('画像削除レスポンスが不正:', response.data);
				return false;
			}
		} catch (error) {
			console.error('Gyazo API削除エラー:', error);
			return false;
		}
	}

	onunload() {
		// プラグインがアンロードされたときの処理
		// タイマーをクリア
		this.clearFetchTimer();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// 定期取得のタイマーを設定するメソッド
	setupFetchTimer() {
		// 既存のタイマーをクリア
		this.clearFetchTimer();

		// 定期取得が無効な場合は何もしない
		if (this.settings.fetchInterval <= 0) {
			console.log('定期取得は無効です');
			return;
		}

		// 次回の取得時間を計算
		const now = Date.now();
		const lastFetch = this.settings.lastFetchTime || 0;
		const interval = this.settings.fetchInterval * 60 * 60 * 1000; // 時間をミリ秒に変換

		// 次回の取得までの時間を計算
		let nextFetch = lastFetch + interval;
		if (nextFetch < now) {
			// 既に時間が過ぎている場合は、次の間隔の開始時間を設定
			nextFetch = now + interval;
		}

		const timeToNextFetch = nextFetch - now;
		console.log(`定期取得: ${this.settings.fetchInterval}時間ごと、次回の取得まで ${Math.round(timeToNextFetch / (60 * 1000))} 分`);

		// タイマーを設定
		this.fetchTimer = setTimeout(() => {
			this.executeFetchTimer();
		}, timeToNextFetch);
	}

	// 定期取得のタイマーをクリアするメソッド
	clearFetchTimer() {
		if (this.fetchTimer) {
			clearTimeout(this.fetchTimer);
			this.fetchTimer = null;
		}
	}

	// 定期取得を実行するメソッド
	async executeFetchTimer() {
		console.log('定期取得を実行します');
		
		// 画像取得を実行
		await this.fetchGyazoImages();
		
		// 最後の取得時間を更新
		this.settings.lastFetchTime = Date.now();
		await this.saveSettings();
		
		// 次回のタイマーを設定
		this.setupFetchTimer();
	}

	async fetchGyazoImages() {
		if (!this.settings.clientId) {
			new Notice('Gyazo Client IDが設定されていません。設定画面で入力してください。');
			return;
		}

		try {
			// 複数ページの画像を取得するための配列
			let allImages: GyazoImage[] = [];
			let currentPage = 1;
			const perPage = 20;
			let hasMorePages = true;

			// 設定された最大画像数から必要なページ数を計算
			const maxImagesToFetch = this.settings.maxImagesToFetch;
			const maxPages = Math.ceil(maxImagesToFetch / perPage);
			console.log(`最大${maxImagesToFetch}枚の画像を取得します（最大${maxPages}ページ）`);


			while (hasMorePages && currentPage <= maxPages) {
				console.log(`Gyazo画像取得中: ページ ${currentPage}`);
				
				// Gyazo APIから画像リストを取得
				const response = await axios.get('https://api.gyazo.com/api/images', {
					params: {
						access_token: this.settings.clientId,
						page: currentPage,
						per_page: perPage
					}
				});

				if (response.status !== 200) {
					new Notice(`Gyazo APIエラー: ${response.status}`);
					return;
				}

				const pageImages = response.data as GyazoImage[];
				
				// 取得した画像を全体の配列に追加
				allImages = [...allImages, ...pageImages];

				// 次のページがあるかどうかを判断
				if (pageImages.length < perPage) {
					hasMorePages = false;
				} else {
					currentPage++;
				}

				// 最後に取得したIDと同じIDの画像が見つかった場合、それ以降は取得済みなのでループを終了
				if (this.settings.lastFetchedId && !this.settings.forceRefetch) {
					const foundLastFetchedImage = pageImages.some(img => img.image_id === this.settings.lastFetchedId);
					if (foundLastFetchedImage) {
						console.log(`最後に取得した画像ID ${this.settings.lastFetchedId} が見つかりました。ページネーションを終了します。`);
						hasMorePages = false;
					}
				}
			}

			const images = allImages;
			if (images.length === 0) {
				new Notice('Gyazoに画像がありません。');
				return;
			}

			// デバッグ情報を出力
			console.log('取得した画像リスト:', images);

			// 保存ディレクトリの確認と作成
			const saveFolder = await this.ensureSaveDirectory();

			// 強制再取得オプションが有効な場合、既存のノートを削除する
			if (this.settings.forceRefetch) {
				new Notice('強制再取得モード: 既存のノートを削除します...');
				
				// 保存ディレクトリ内のファイルを取得
				const files = this.app.vault.getMarkdownFiles().filter(file => {
					return file.path.startsWith(this.settings.saveDirectory + '/');
				});

				// Gyazoノートを削除
				let deletedCount = 0;
				for (const file of files) {
					try {
						// ファイルの内容を取得してGyazoノートか確認
						const content = await this.app.vault.read(file);
						if (content.includes('gyazo_id:')) {
							await this.app.vault.delete(file);
							deletedCount++;
						}
					} catch (error) {
						console.error(`ファイル削除エラー: ${file.path}`, error);
					}
				}

				new Notice(`${deletedCount}件のノートを削除しました。新しく取得します...`);
				
				// 最後に取得したIDをリセット
				this.settings.lastFetchedId = '';
				await this.saveSettings();
			}

			// 画像ごとにノートを作成
			let createdCount = 0;
			let updatedCount = 0;

			for (const image of images) {
				// 画像IDが存在するか確認
				if (!image.image_id) {
					console.error('画像IDが存在しません:', image);
					continue;
				}

				console.log('処理中の画像ID:', image.image_id);

				// 最後に取得したIDと同じなら、それ以降は処理しない
				if (this.settings.lastFetchedId && image.image_id === this.settings.lastFetchedId) {
					break;
				}

				// 画像の詳細情報を取得
				const imageDetail = await this.fetchImageDetail(image.image_id);
				if (!imageDetail) {
					console.error(`画像詳細の取得に失敗: ${image.image_id}`);
					continue;
				}

				// ノートを作成または更新
				const result = await this.createOrUpdateNote(imageDetail);
				if (result === 'created') createdCount++;
				if (result === 'updated') updatedCount++;
			}

			// 最後に取得したIDと時間を保存
			if (images.length > 0 && images[0].image_id) {
				this.settings.lastFetchedId = images[0].image_id;
				this.settings.lastFetchTime = Date.now();
				await this.saveSettings();
			}

			// 削除された画像の検知と処理
			if (this.settings.detectDeletedImages) {
				await this.checkForDeletedImages(images);
			}

			new Notice(`Gyazo画像処理完了: ${createdCount}件作成, ${updatedCount}件更新`);

		} catch (error) {
			console.error('Gyazo API error:', error);
			new Notice(`Gyazo APIエラー: ${error.message || error}`);
		}
	}

	// 削除された画像を検知して処理するメソッド
	async checkForDeletedImages(currentImages: GyazoImage[]) {
		try {
			// 現在のGyazo画像IDリストを作成
			const currentImageIds = new Set<string>();
			for (const image of currentImages) {
				if (image.image_id) {
					currentImageIds.add(image.image_id);
				}
			}

			console.log(`現在のGyazo画像数: ${currentImageIds.size}枚`);

			// 保存ディレクトリ内のファイルを取得
			const files = this.app.vault.getMarkdownFiles().filter(file => {
				return file.path.startsWith(this.settings.saveDirectory + '/');
			});

			console.log(`Gyazoノート数: ${files.length}件`);

			// 各ノートのGyazo IDを取得し、現在の画像リストに存在しない場合は削除されたと判断
			let deletedCount = 0;
			let potentiallyDeletedImages: {imageId: string, filePath: string}[] = [];

			// まず、現在の画像リストに存在しないノートを検出
			for (const file of files) {
				try {
					// ファイルの内容を取得
					const content = await this.app.vault.read(file);
					
					// Gyazo IDを抽出
					const imageId = this.extractGyazoIdFromNote(content);
					if (imageId && !currentImageIds.has(imageId)) {
						// 可能性のある削除画像として記録
						potentiallyDeletedImages.push({imageId, filePath: file.path});
					}
				} catch (error) {
					console.error(`ノート読み込みエラー: ${file.path}`, error);
				}
			}

			console.log(`可能性のある削除画像: ${potentiallyDeletedImages.length}件`);

			// 可能性のある削除画像ごとに、実際に削除されたか確認
			for (const item of potentiallyDeletedImages) {
				try {
					// 画像の詳細情報を取得して、実際に存在するか確認
					const imageDetail = await this.fetchImageDetail(item.imageId);
					
					// 画像が存在しない場合は削除されたと判断
					if (!imageDetail) {
						console.log(`削除された画像を確認: ${item.imageId}, ノート: ${item.filePath}`);
						
						// ノートファイルを取得
						const file = this.app.vault.getAbstractFileByPath(item.filePath);
						if (file instanceof TFile) {
							// 自動削除設定が有効な場合はノートを削除
							if (this.settings.deleteNotesForDeletedImages) {
								await this.app.vault.delete(file);
								deletedCount++;
								console.log(`削除された画像のノートを削除: ${item.filePath}`);
							} else {
								// 自動削除が無効な場合は通知のみ
								new Notice(`Gyazoで削除された画像があります: ${item.filePath}`);
							}
						}
					} else {
						// 画像が存在する場合は、ページネーションの制限で取得できなかっただけ
						console.log(`画像は存在しますが、ページネーションの制限で取得されませんでした: ${item.imageId}`);
					}
				} catch (error) {
					console.error(`画像確認エラー (${item.imageId}): ${error.message || error}`);
				}
			}

			// 削除されたノートがあれば通知
			if (deletedCount > 0) {
				new Notice(`Gyazoで削除された画像のノートを${deletedCount}件削除しました`);
			}
		} catch (error) {
			console.error('削除画像検知エラー:', error);
		}
	}

	// ノートからGyazo IDを抽出するメソッド
	extractGyazoIdFromNote(content: string): string | null {
		const match = content.match(/gyazo_id:\s*([a-zA-Z0-9]+)/);
		return match ? match[1] : null;
	}

	async fetchImageDetail(imageId: string): Promise<GyazoImage | null> {
		if (!imageId) {
			console.error('画像IDが空です');
			return null;
		}

		console.log(`画像詳細を取得中: ${imageId}`);

		try {
			// 画像の詳細情報を取得
			const url = `https://api.gyazo.com/api/images/${imageId}`;
			console.log(`リクエストURL: ${url}`);

			const response = await axios.get(url, {
				params: {
					access_token: this.settings.clientId
				}
			});

			if (response.status !== 200) {
				console.error(`画像詳細の取得エラー: ${response.status}`);
				return null;
			}

			console.log(`画像詳細取得成功: ${imageId}`, response.data);
			return response.data as GyazoImage;
		} catch (error) {
			console.error(`画像詳細の取得エラー (${imageId}): ${error.message || error}`);
			return null;
		}
	}

	async ensureSaveDirectory(): Promise<TFolder> {
		const vault = this.app.vault;
		const dirPath = this.settings.saveDirectory;

		// ディレクトリが存在するか確認
		let dir = vault.getAbstractFileByPath(dirPath) as TFolder;
		if (!dir) {
			// ディレクトリが存在しない場合は作成
			dir = await vault.createFolder(dirPath);
		}

		return dir;
	}

	async createOrUpdateNote(image: GyazoImage): Promise<'created' | 'updated' | 'skipped'> {
		const vault = this.app.vault;
		
		// 日付と時間をYYYY-MM-DD_HHMMSS形式で取得
		const createdDateTime = new Date(image.created_at);
		const createdDate = createdDateTime.toISOString().split('T')[0];
		const createdTime = `${String(createdDateTime.getHours()).padStart(2, '0')}${String(createdDateTime.getMinutes()).padStart(2, '0')}${String(createdDateTime.getSeconds()).padStart(2, '0')}`;
		
		// ファイル名の作成
		const appName = image.metadata?.app ? this.sanitizeFileName(image.metadata.app) : '';
		const title = image.metadata?.title ? this.sanitizeFileName(image.metadata.title) : '';
		
		// ファイル名の生成
		let fileNameBase = `Gyazo ${createdDate}_${createdTime}`;
		if (appName) fileNameBase += ` ${appName}`;
		if (title) fileNameBase += ` ${title}`;
		if (!appName && !title) fileNameBase += ` ${image.image_id}`;
		
		const fileName = `${this.settings.saveDirectory}/${fileNameBase}.md`;

		// ファイルが既に存在するか確認
		const existingFile = vault.getAbstractFileByPath(fileName) as TFile;
		if (existingFile) {
			// 既存のファイルを更新
			try {
				// 既存のノートの内容を取得
				const existingContent = await vault.read(existingFile);
				
				// 新しいメタデータを生成
				const newMetadata = this.createMetadata(image);
				
				// 既存の内容をメタデータと本文に分割
				const parts = this.splitNoteContent(existingContent);
				
				// OCRデータの処理
				let updatedContent = parts.body;
				
				// 新しいOCRデータがあるか確認
				if (image.ocr?.description && !existingContent.includes('## OCRテキスト')) {
					// OCRデータが新しく追加された場合は追記
					updatedContent += `\n\n## OCRテキスト\n${image.ocr.description}\n`;
				}
				
				// メタデータと本文を結合
				const finalContent = `---\n${newMetadata}---\n\n${updatedContent}`;
				
				// ファイルを更新
				await vault.modify(existingFile, finalContent);
				return 'updated';
			} catch (error) {
				console.error('ノート更新エラー:', error);
				new Notice('ノートの更新に失敗しました');
				return 'skipped';
			}
		} else {
			// 新しいファイルを作成
			const noteContent = this.createNoteContent(image);
			await vault.create(fileName, noteContent);
			return 'created';
		}
	}

	// ファイル名に使用できない文字を除去するメソッド
	sanitizeFileName(name: string): string {
		// ファイル名に使用できない文字を除去し、スペースで置き換え
		return name.replace(/[\\/:\*\?\"<>\|]/g, ' ').trim();
	}

	// メタデータ部分のみを生成するメソッド
	createMetadata(image: GyazoImage): string {
		const createdDate = new Date(image.created_at).toISOString().split('T')[0];
		let metadata = `category:
  - "[[Gyazo Images]]"
gyazo_id: ${image.image_id}
created_at: ${image.created_at}
created: ${createdDate}
type: ${image.type}
permalink_url: ${image.permalink_url}
url: ${image.url}
thumb_url: ${image.thumb_url}
`;

		// メタデータがあれば追加
		if (image.metadata) {
			if (image.metadata.app) metadata += `app: ${image.metadata.app}
`;
			if (image.metadata.title) metadata += `title: ${image.metadata.title}
`;
			if (image.metadata.url) metadata += `source_url: ${image.metadata.url}
`;
			if (image.metadata.desc) metadata += `description: ${image.metadata.desc}
`;
		}

		// OCRデータがあれば追加
		if (image.ocr) {
			metadata += `ocr_locale: ${image.ocr.locale}
`;
		}

		return metadata;
	}

	// ノートの内容をメタデータと本文に分割するメソッド
	splitNoteContent(content: string): { metadata: string, body: string } {
		// メタデータと本文を分割
		const metadataRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
		const match = content.match(metadataRegex);
		
		if (match && match.length >= 3) {
			return {
				metadata: match[1],
				body: match[2].trim()
			};
		}
		
		// メタデータが見つからない場合は、全体を本文として扱う
		return {
			metadata: '',
			body: content.trim()
		};
	}

	createNoteContent(image: GyazoImage): string {
		const createdDate = new Date(image.created_at).toISOString().split('T')[0];
		const title = image.metadata?.title || `Gyazo Image ${image.image_id}`;

		// メタデータを生成
		const metadata = this.createMetadata(image);

		// 本文を生成
		let body = `# ${title}

![${title}](${image.url})

`;

		// Gyazoページへのリンクを追加
		body += `[Gyazoで表示](${image.permalink_url})

`;

		// 説明があれば追加
		if (image.metadata?.desc) {
			body += `## 説明
${image.metadata.desc}

`;
		}

		// OCRテキストがあれば追加
		if (image.ocr?.description) {
			body += `## OCRテキスト
${image.ocr.description}

`;
		}

		return `---
${metadata}---

${body}`;
	}
}

class GyazoSettingTab extends PluginSettingTab {
	plugin: GyazoPlugin;

	constructor(app: App, plugin: GyazoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Gyazo連携設定'});

		new Setting(containerEl)
			.setName('Gyazo Client ID')
			.setDesc('Gyazo APIのクライアントIDを入力してください。Gyazo APIのページから取得できます。')
			.addText(text => text
				.setPlaceholder('Client IDを入力')
				.setValue(this.plugin.settings.clientId)
				.onChange(async (value) => {
					this.plugin.settings.clientId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('保存ディレクトリ')
			.setDesc('Gyazo画像のノートを保存するディレクトリを指定してください。')
			.addText(text => text
				.setPlaceholder('例: Gyazo')
				.setValue(this.plugin.settings.saveDirectory)
				.onChange(async (value) => {
					this.plugin.settings.saveDirectory = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('強制再取得')
			.setDesc('ノートを消して再取得するかどうかを指定します。チェックすると、既存のノートを削除して再取得します。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.forceRefetch)
				.onChange(async (value) => {
					this.plugin.settings.forceRefetch = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('定期取得間隔')
			.setDesc('定期的に画像を取得する間隔を時間単位で指定します。0の場合は定期取得を行いません。')
			.addSlider(slider => slider
				.setLimits(0, 24, 1)
				.setValue(this.plugin.settings.fetchInterval)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.fetchInterval = value;
					await this.plugin.saveSettings();
					
					// 定期取得のタイマーを再設定
					this.plugin.setupFetchTimer();
				}))
			.addExtraButton(button => {
				button
					.setIcon('info')
					.setTooltip('現在の設定: ' + (this.plugin.settings.fetchInterval === 0 ? '定期取得なし' : `${this.plugin.settings.fetchInterval}時間ごと`))
					.onClick(() => {
						new Notice(this.plugin.settings.fetchInterval === 0 ? '定期取得は無効です' : `定期取得: ${this.plugin.settings.fetchInterval}時間ごとに実行されます`);
					});
			});

		containerEl.createEl('h3', {text: '削除された画像の処理'});

		new Setting(containerEl)
			.setName('削除された画像を検知する')
			.setDesc('Gyazoで削除された画像を検知して通知します。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.detectDeletedImages)
				.onChange(async (value) => {
					this.plugin.settings.detectDeletedImages = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('削除された画像のノートも削除する')
			.setDesc('Gyazoで削除された画像に対応するノートを自動的に削除します。チェックしない場合は通知のみを行います。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.deleteNotesForDeletedImages)
				.onChange(async (value) => {
					this.plugin.settings.deleteNotesForDeletedImages = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', {text: '画像取得設定'});

		new Setting(containerEl)
			.setName('一度に取得する最大画像枚数')
			.setDesc('Gyazoから一度に取得する最新画像の最大枚数を指定します。大きな値を設定すると処理に時間がかかります。')
			.addSlider(slider => slider
				.setLimits(20, 100, 10)
				.setValue(this.plugin.settings.maxImagesToFetch)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxImagesToFetch = value;
					await this.plugin.saveSettings();
				}))
			.addExtraButton(button => {
				button
					.setIcon('info')
					.setTooltip(`現在の設定: 最大${this.plugin.settings.maxImagesToFetch}枚取得`)
					.onClick(() => {
						new Notice(`一度に取得する最大画像枚数: ${this.plugin.settings.maxImagesToFetch}枚`);
					});
			});

		containerEl.createEl('p', {
			text: 'Gyazo APIの詳細については、https://gyazo.com/api/docs を参照してください。'
		});
	}
}
