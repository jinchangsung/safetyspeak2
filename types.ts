export enum TargetLanguage {
  KOREAN = 'Korean',
  ENGLISH = 'English',
  CHINESE = 'Chinese (Simplified)',
  VIETNAMESE = 'Vietnamese',
  RUSSIAN = 'Russian',
  UZBEK = 'Uzbek'
}

export interface TranslationResult {
  originalText: string;
  translatedText: string;
  targetLanguage: TargetLanguage;
  audioBuffer: AudioBuffer | null;
}

export type ProcessStatus = 'idle' | 'extracting' | 'translating' | 'speaking' | 'completed' | 'error';

export interface QueueItem {
  id: string;
  file?: File; // Optional, might be manual text input
  fileName: string;
  originalText: string; // Extracted text or manual input
  translatedText?: string;
  targetLanguage: TargetLanguage;
  status: ProcessStatus;
  error?: string;
  audioBuffer?: AudioBuffer | null;
}

export interface AppState {
  queue: QueueItem[];
  selectedLanguage: TargetLanguage;
  isProcessingQueue: boolean;
  currentItemId: string | null;
  globalError: string | null;
  autoPlay: boolean;
}

// Map for display names to native/readable names
export const LANGUAGE_LABELS: Record<TargetLanguage, { label: string; native: string; flag: string }> = {
  [TargetLanguage.KOREAN]: { label: '한국어', native: '한국어', flag: '🇰🇷' },
  [TargetLanguage.ENGLISH]: { label: '영어', native: 'English', flag: '🇺🇸' },
  [TargetLanguage.CHINESE]: { label: '중국어 (간체)', native: '中文 (简体)', flag: '🇨🇳' },
  [TargetLanguage.VIETNAMESE]: { label: '베트남어', native: 'Tiếng Việt', flag: '🇻🇳' },
  [TargetLanguage.RUSSIAN]: { label: '러시아어', native: 'Русский', flag: '🇷🇺' },
  [TargetLanguage.UZBEK]: { label: '우즈베키스탄어', native: 'Oʻzbekcha', flag: '🇺🇿' },
};