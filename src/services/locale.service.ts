import i18next from 'i18next';
import en from '../locales/en.json';
import fr from '../locales/fr.json';
import yo from '../locales/yo.json';

const SUPPORTED_LANGUAGES = ['en', 'fr', 'yo'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

let initialised = false;

export async function initI18n(): Promise<void> {
  if (initialised) return;
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: { translation: en },
      fr: { translation: fr },
      yo: { translation: yo },
    },
    interpolation: {
      // i18next escapes HTML by default; unnecessary in WhatsApp text
      escapeValue: false,
    },
  });
  initialised = true;
}

export function t(key: string, lang: string, params?: Record<string, string | number>): string {
  const resolvedLang = SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage) ? lang : 'en';

  return i18next.t(key, { lng: resolvedLang, ...params });
}

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage);
}
