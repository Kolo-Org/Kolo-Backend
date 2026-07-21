import i18next from 'i18next';
import Backend from 'i18next-fs-backend';
import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';

const SUPPORTED_LANGUAGES = ['en', 'fr', 'yo', 'pcm', 'ha', 'ig'] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

let initialised = false;

export async function initI18n(): Promise<void> {
    if (initialised) return;

    const localesDir = path.join(__dirname, '../locales');

    await i18next
        .use(Backend)
        .init({
            lng: 'en',
            fallbackLng: 'en',
            preload: [...SUPPORTED_LANGUAGES],
            backend: {
                loadPath: path.join(localesDir, '{{lng}}.json'),
            },
            interpolation: {
                escapeValue: false
            },
        });

    // Validate translations against en.json
    try {
        const enPath = path.join(localesDir, 'en.json');
        const enData = JSON.parse(fs.readFileSync(enPath, 'utf8'));
        const checkKeys = (obj: any, prefix = '') => {
            const keys: string[] = [];
            for (const k in obj) {
                if (typeof obj[k] === 'object' && obj[k] !== null) {
                    keys.push(...checkKeys(obj[k], `${prefix}${k}.`));
                } else {
                    keys.push(`${prefix}${k}`);
                }
            }
            return keys;
        };
        const enKeys = checkKeys(enData);
        
        for (const lang of SUPPORTED_LANGUAGES) {
            if (lang === 'en') continue;
            try {
                const langPath = path.join(localesDir, `${lang}.json`);
                if (!fs.existsSync(langPath)) {
                    console.warn(`[i18n] Missing translation file: ${lang}.json`);
                    continue;
                }
                const langData = JSON.parse(fs.readFileSync(langPath, 'utf8'));
                const langKeys = new Set(checkKeys(langData));
                for (const key of enKeys) {
                    if (!langKeys.has(key)) {
                        console.warn(`[i18n] Missing key '${key}' in ${lang}.json`);
                    }
                }
            } catch (err) {
                console.warn(`[i18n] Could not load/validate ${lang}.json`);
            }
        }
    } catch (err) {
        console.error('[i18n] Failed to validate locales on startup', err);
    }

    // Watch for hot reloading
    chokidar.watch(localesDir).on('all', (event, filePath) => {
        if (filePath.endsWith('.json')) {
            const lang = path.basename(filePath, '.json');
            if (SUPPORTED_LANGUAGES.includes(lang as any)) {
                console.log(`[i18n] Reloading translations for ${lang}`);
                i18next.reloadResources(lang).catch(err => {
                    console.error(`[i18n] Reload failed for ${lang}`, err);
                });
            }
        }
    });

    initialised = true;
}

export function isRTL(lang: string): boolean {
    return lang === 'ar';
}

export function t(
    key: string,
    lang: string,
    params?: Record<string, any>,
): string {
    const resolvedLang = SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)
        ? lang
        : 'en';

    let message = i18next.t(key, { lng: resolvedLang, ...params });
    
    // Arabic/Hausa RTL support
    if (isRTL(resolvedLang)) {
        message = '\u200F' + message;
    }
    
    return message;
}

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
    return SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage);
}
