export const SUPPORTED_LOCALES = ["en", "de", "ja", "zh-CN", "zh-TW"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const APP_LANGUAGE_STORAGE_KEY = "mmd-convert.locale";

export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: "English",
  de: "Deutsch",
  ja: "日本語",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

let currentLocale: AppLocale = "de";

function normalizeBaseLocale(locale: string): string {
  return locale.trim().toLowerCase().replace(/_/g, "-");
}

export function normalizeLocale(locale: string): AppLocale | null {
  const normalized = normalizeBaseLocale(locale);

  if (normalized.startsWith("de")) return "de";
  if (normalized.startsWith("en")) return "en";
  if (normalized.startsWith("ja")) return "ja";

  if (
    normalized === "zh-cn" ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-hans")
  ) {
    return "zh-CN";
  }

  if (
    normalized === "zh-tw" ||
    normalized === "zh-hk" ||
    normalized === "zh-mo" ||
    normalized.startsWith("zh-hant")
  ) {
    return "zh-TW";
  }

  return null;
}

export function detectBrowserLocale(): AppLocale {
  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );

  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }

  return "en";
}

export function getStoredLocale(): AppLocale | null {
  try {
    const stored = localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
    if (!stored) return null;
    return normalizeLocale(stored);
  } catch {
    return null;
  }
}

export function storeLocale(locale: AppLocale): void {
  try {
    localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures (private mode, disabled storage).
  }
}

export function getInitialLocale(): AppLocale {
  return getStoredLocale() ?? detectBrowserLocale();
}

export function setCurrentLocale(locale: AppLocale): void {
  currentLocale = locale;
}

export function getCurrentLocale(): AppLocale {
  return currentLocale;
}

export interface ViewStrings {
  language: string;
  themeToDark: string;
  themeToLight: string;
  heroKicker: string;
  heroSubPrefix: string;
  heroSubLink: string;
  tabCardCreate: string;
  tabCardExtract: string;
  tabBpmxToPmx: string;
  tabPmxToBpmx: string;
  tabMotionToBvmd: string;
  tabBvmdToVmd: string;
  tabAudioToWebm: string;
  tabShowMore: string;
  tabShowLess: string;
  statusReady: string;
  statusEmptyInput: string;
  statusConverting: string;
  statusErrorPrefix: string;
  noWarnings: string;
}

const VIEW_STRINGS: Record<AppLocale, ViewStrings> = {
  en: {
    language: "Language",
    themeToDark: "Switch to dark mode",
    themeToLight: "Switch to light mode",
    heroKicker: "Extract MMD files from ero.dance cards or create new cards",
    heroSubPrefix: "Find the source code at",
    heroSubLink: "GitHub/../mmd-card-converter",
    tabCardCreate: "Create Card",
    tabCardExtract: "Extract MMD from Card",
    tabBpmxToPmx: "BPMX -> PMX",
    tabPmxToBpmx: "PMX -> BPMX",
    tabMotionToBvmd: "VMD/VPD/VMP -> BVMD",
    tabBvmdToVmd: "BVMD -> VMD",
    tabAudioToWebm: "WAV/MP3 -> WebM",
    tabShowMore: "Show more converters",
    tabShowLess: "Show fewer converters",
    statusReady: "Ready",
    statusEmptyInput: "Add files first",
    statusConverting: "Converting...",
    statusErrorPrefix: "Error",
    noWarnings:
      "No warnings. Reconstruction completed without known critical deviations.",
  },
  de: {
    language: "Sprache",
    themeToDark: "Zum Dark Mode wechseln",
    themeToLight: "Zum Light Mode wechseln",
    heroKicker:
      "Extrahiere MMD-Dateien aus ero.dance Cards oder erstelle neue Cards",
    heroSubPrefix: "Quellcode auf",
    heroSubLink: "GitHub/../mmd-card-converter",
    tabCardCreate: "Card erstellen",
    tabCardExtract: "MMD aus Card extrahieren",
    tabBpmxToPmx: "BPMX -> PMX",
    tabPmxToBpmx: "PMX -> BPMX",
    tabMotionToBvmd: "VMD/VPD/VMP -> BVMD",
    tabBvmdToVmd: "BVMD -> VMD",
    tabAudioToWebm: "WAV/MP3 -> WebM",
    tabShowMore: "Weitere Konverter anzeigen",
    tabShowLess: "Weitere Konverter ausblenden",
    statusReady: "Bereit",
    statusEmptyInput: "Füge zuerst Dateien hinzu",
    statusConverting: "Konvertiere...",
    statusErrorPrefix: "Fehler",
    noWarnings:
      "Keine Warnungen. Rekonstruktion ohne bekannte kritische Abweichungen.",
  },
  ja: {
    language: "言語",
    themeToDark: "ダークモードに切り替え",
    themeToLight: "ライトモードに切り替え",
    heroKicker:
      "ero.danceカードからMMDファイルを抽出、または新しいカードを作成",
    heroSubPrefix: "ソースコード",
    heroSubLink: "GitHub/../mmd-card-converter",
    tabCardCreate: "カード作成",
    tabCardExtract: "カードからMMDを抽出",
    tabBpmxToPmx: "BPMX -> PMX",
    tabPmxToBpmx: "PMX -> BPMX",
    tabMotionToBvmd: "VMD/VPD/VMP -> BVMD",
    tabBvmdToVmd: "BVMD -> VMD",
    tabAudioToWebm: "WAV/MP3 -> WebM",
    tabShowMore: "コンバーターをさらに表示",
    tabShowLess: "コンバーターを折りたたむ",
    statusReady: "準備完了",
    statusEmptyInput: "先にファイルを追加してください",
    statusConverting: "変換中...",
    statusErrorPrefix: "エラー",
    noWarnings: "警告はありません。既知の重大な差異なしで再構築されました。",
  },
  "zh-CN": {
    language: "语言",
    themeToDark: "切换到深色模式",
    themeToLight: "切换到浅色模式",
    heroKicker: "从 ero.dance 卡片提取 MMD 文件，或创建新卡片",
    heroSubPrefix: "源代码",
    heroSubLink: "github.com/../mmd-card-converter",
    tabCardCreate: "创建卡片",
    tabCardExtract: "从卡片提取 MMD",
    tabBpmxToPmx: "BPMX -> PMX",
    tabPmxToBpmx: "PMX -> BPMX",
    tabMotionToBvmd: "VMD/VPD/VMP -> BVMD",
    tabBvmdToVmd: "BVMD -> VMD",
    tabAudioToWebm: "WAV/MP3 -> WebM",
    tabShowMore: "显示更多转换器",
    tabShowLess: "收起额外转换器",
    statusReady: "就绪",
    statusEmptyInput: "请先添加文件",
    statusConverting: "转换中...",
    statusErrorPrefix: "错误",
    noWarnings: "没有警告。重建未发现已知关键偏差。",
  },
  "zh-TW": {
    language: "語言",
    themeToDark: "切換到深色模式",
    themeToLight: "切換到淺色模式",
    heroKicker: "從 ero.dance 卡片擷取 MMD 檔案，或建立新卡片",
    heroSubPrefix: "原始碼",
    heroSubLink: "GitHub/../mmd-card-converter",
    tabCardCreate: "建立卡片",
    tabCardExtract: "從卡片擷取 MMD",
    tabBpmxToPmx: "BPMX -> PMX",
    tabPmxToBpmx: "PMX -> BPMX",
    tabMotionToBvmd: "VMD/VPD/VMP -> BVMD",
    tabBvmdToVmd: "BVMD -> VMD",
    tabAudioToWebm: "WAV/MP3 -> WebM",
    tabShowMore: "顯示更多轉換器",
    tabShowLess: "收合額外轉換器",
    statusReady: "就緒",
    statusEmptyInput: "請先加入檔案",
    statusConverting: "轉換中...",
    statusErrorPrefix: "錯誤",
    noWarnings: "沒有警告。重建未發現已知關鍵偏差。",
  },
};

export function getViewStrings(locale: AppLocale): ViewStrings {
  return VIEW_STRINGS[locale] ?? VIEW_STRINGS.en;
}

interface ErrorStrings {
  audioNoBuffer: string;
  audioNoEncoder: string;
  audioOpusUnavailable: string;
  audioSupportCheckFailed: string;
  audioUnsupportedInput: string;
  audioEncodingUnsupported: string;
  audioTrackMissing: string;
  audioConversionFailed: string;
  defaultBaseImageLoadFailed: string;
  pngIncomplete: string;
  pngChunkTruncated: string;
  pngIendMissing: string;
  pngTooSmall: string;
  pngInvalidSignature: string;
  cardNoKnownChunks: string;
  bmpUnsupportedFile: string;
  bmpUnsupportedHeader: string;
  bmpUnsupportedPixelFormat: string;
  bmpCorruptFile: string;
  no2dOffscreen: string;
  no2dCanvas: string;
}

const ERROR_STRINGS: Record<AppLocale, ErrorStrings> = {
  en: {
    audioNoBuffer: "The browser did not produce a WebM buffer.",
    audioNoEncoder: "This browser does not support AudioEncoder for WebM/Opus.",
    audioOpusUnavailable:
      "Opus encoding is currently unavailable in this browser.",
    audioSupportCheckFailed: "Could not determine browser support.",
    audioUnsupportedInput: "Only WAV and MP3 files are supported.",
    audioEncodingUnsupported:
      "WebM audio encoding is not supported in this environment.",
    audioTrackMissing: "The file does not contain a decodable audio track.",
    audioConversionFailed:
      "The file could not be converted to a WebM audio file.",
    defaultBaseImageLoadFailed: "Could not load default image /eroLogo.png.",
    pngIncomplete: "PNG is incomplete and cannot be read.",
    pngChunkTruncated: "PNG chunk is truncated and cannot be read.",
    pngIendMissing: "PNG does not contain a valid IEND chunk.",
    pngTooSmall: "File is too small for a valid PNG.",
    pngInvalidSignature: "File is not a valid PNG.",
    cardNoKnownChunks:
      "No known card chunks found. Only ero.dance.png was exported.",
    bmpUnsupportedFile: "Unsupported BMP file",
    bmpUnsupportedHeader: "Unsupported BMP header",
    bmpUnsupportedPixelFormat: "Unsupported BMP pixel format",
    bmpCorruptFile: "Corrupt BMP file",
    no2dOffscreen: "Could not get 2D context from OffscreenCanvas",
    no2dCanvas: "Could not get 2D context from HTMLCanvasElement",
  },
  de: {
    audioNoBuffer: "Der Browser hat keinen WebM-Buffer erzeugt.",
    audioNoEncoder:
      "Dieser Browser unterstützt keinen AudioEncoder für WebM/Opus.",
    audioOpusUnavailable:
      "Opus-Encoding ist in diesem Browser derzeit nicht verfügbar.",
    audioSupportCheckFailed:
      "Die Browser-Unterstützung konnte nicht geprüft werden.",
    audioUnsupportedInput: "Es werden nur WAV- und MP3-Dateien unterstützt.",
    audioEncodingUnsupported:
      "WebM-Audio-Encoding wird hier nicht unterstützt.",
    audioTrackMissing: "Die Datei enthält keine dekodierbare Audiospur.",
    audioConversionFailed:
      "Die Datei konnte nicht in eine WebM-Audiodatei umgewandelt werden.",
    defaultBaseImageLoadFailed:
      "Default-Bild /eroLogo.png konnte nicht geladen werden.",
    pngIncomplete: "PNG ist unvollständig und kann nicht gelesen werden.",
    pngChunkTruncated:
      "PNG-Chunk ist abgeschnitten und kann nicht gelesen werden.",
    pngIendMissing: "PNG enthält keinen gültigen IEND-Chunk.",
    pngTooSmall: "Datei ist zu klein fuer eine gueltige PNG.",
    pngInvalidSignature: "Datei ist keine gueltige PNG.",
    cardNoKnownChunks:
      "Keine bekannten Card-Chunkdaten gefunden. Es wurde nur ero.dance.png exportiert.",
    bmpUnsupportedFile: "Nicht unterstützte BMP-Datei",
    bmpUnsupportedHeader: "Nicht unterstützter BMP-Header",
    bmpUnsupportedPixelFormat: "Nicht unterstütztes BMP-Pixelformat",
    bmpCorruptFile: "Beschädigte BMP-Datei",
    no2dOffscreen:
      "2D-Kontext von OffscreenCanvas konnte nicht erstellt werden",
    no2dCanvas: "2D-Kontext von HTMLCanvasElement konnte nicht erstellt werden",
  },
  ja: {
    audioNoBuffer: "ブラウザがWebMバッファを生成しませんでした。",
    audioNoEncoder:
      "このブラウザは WebM/Opus 用の AudioEncoder をサポートしていません。",
    audioOpusUnavailable:
      "このブラウザでは現在 Opus エンコードを利用できません。",
    audioSupportCheckFailed: "ブラウザの対応状況を確認できませんでした。",
    audioUnsupportedInput: "WAV と MP3 ファイルのみ対応しています。",
    audioEncodingUnsupported:
      "この環境では WebM 音声エンコードに対応していません。",
    audioTrackMissing: "デコード可能な音声トラックが見つかりません。",
    audioConversionFailed: "ファイルを WebM 音声に変換できませんでした。",
    defaultBaseImageLoadFailed:
      "デフォルト画像 /eroLogo.png を読み込めませんでした。",
    pngIncomplete: "PNG データが不完全で読み取れません。",
    pngChunkTruncated: "PNG チャンクが途中で切れており読み取れません。",
    pngIendMissing: "有効な IEND チャンクが見つかりません。",
    pngTooSmall: "有効な PNG としてはファイルサイズが小さすぎます。",
    pngInvalidSignature: "有効な PNG ファイルではありません。",
    cardNoKnownChunks:
      "既知のカードチャンクが見つからなかったため、ero.dance.png のみを書き出しました。",
    bmpUnsupportedFile: "未対応の BMP ファイルです",
    bmpUnsupportedHeader: "未対応の BMP ヘッダーです",
    bmpUnsupportedPixelFormat: "未対応の BMP ピクセル形式です",
    bmpCorruptFile: "BMP ファイルが破損しています",
    no2dOffscreen: "OffscreenCanvas の 2D コンテキストを取得できませんでした",
    no2dCanvas: "HTMLCanvasElement の 2D コンテキストを取得できませんでした",
  },
  "zh-CN": {
    audioNoBuffer: "浏览器未生成 WebM 缓冲区。",
    audioNoEncoder: "此浏览器不支持用于 WebM/Opus 的 AudioEncoder。",
    audioOpusUnavailable: "当前浏览器暂不支持 Opus 编码。",
    audioSupportCheckFailed: "无法检测浏览器支持情况。",
    audioUnsupportedInput: "仅支持 WAV 和 MP3 文件。",
    audioEncodingUnsupported: "当前环境不支持 WebM 音频编码。",
    audioTrackMissing: "文件中没有可解码的音轨。",
    audioConversionFailed: "文件无法转换为 WebM 音频。",
    defaultBaseImageLoadFailed: "无法加载默认图片 /eroLogo.png。",
    pngIncomplete: "PNG 数据不完整，无法读取。",
    pngChunkTruncated: "PNG 块已截断，无法读取。",
    pngIendMissing: "PNG 不包含有效的 IEND 块。",
    pngTooSmall: "文件过小，不是有效 PNG。",
    pngInvalidSignature: "文件不是有效 PNG。",
    cardNoKnownChunks: "未找到已知卡片块，仅导出了 ero.dance.png。",
    bmpUnsupportedFile: "不支持的 BMP 文件",
    bmpUnsupportedHeader: "不支持的 BMP 头",
    bmpUnsupportedPixelFormat: "不支持的 BMP 像素格式",
    bmpCorruptFile: "BMP 文件已损坏",
    no2dOffscreen: "无法从 OffscreenCanvas 获取 2D 上下文",
    no2dCanvas: "无法从 HTMLCanvasElement 获取 2D 上下文",
  },
  "zh-TW": {
    audioNoBuffer: "瀏覽器未產生 WebM 緩衝區。",
    audioNoEncoder: "此瀏覽器不支援 WebM/Opus 的 AudioEncoder。",
    audioOpusUnavailable: "目前瀏覽器不支援 Opus 編碼。",
    audioSupportCheckFailed: "無法檢查瀏覽器支援狀態。",
    audioUnsupportedInput: "僅支援 WAV 與 MP3 檔案。",
    audioEncodingUnsupported: "此環境不支援 WebM 音訊編碼。",
    audioTrackMissing: "檔案中沒有可解碼的音軌。",
    audioConversionFailed: "無法將檔案轉換為 WebM 音訊。",
    defaultBaseImageLoadFailed: "無法載入預設圖片 /eroLogo.png。",
    pngIncomplete: "PNG 資料不完整，無法讀取。",
    pngChunkTruncated: "PNG 區塊已截斷，無法讀取。",
    pngIendMissing: "PNG 不含有效 IEND 區塊。",
    pngTooSmall: "檔案太小，無法構成有效 PNG。",
    pngInvalidSignature: "檔案不是有效 PNG。",
    cardNoKnownChunks: "找不到已知卡片區塊，僅匯出 ero.dance.png。",
    bmpUnsupportedFile: "不支援的 BMP 檔案",
    bmpUnsupportedHeader: "不支援的 BMP 標頭",
    bmpUnsupportedPixelFormat: "不支援的 BMP 像素格式",
    bmpCorruptFile: "BMP 檔案已損毀",
    no2dOffscreen: "無法從 OffscreenCanvas 取得 2D 內容",
    no2dCanvas: "無法從 HTMLCanvasElement 取得 2D 內容",
  },
};

export function getErrorStrings(
  locale: AppLocale = getCurrentLocale(),
): ErrorStrings {
  return ERROR_STRINGS[locale] ?? ERROR_STRINGS.en;
}
