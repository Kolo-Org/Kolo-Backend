// Tests for locale.service — must achieve 100% statement/branch/function/line coverage.
// We reset i18next between suites by clearing the module registry so initI18n()
// can be called fresh in each describe block without "already initialised" state.

describe('locale.service', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    describe('initI18n', () => {
        it('should initialise without throwing', async () => {
            const { initI18n } = await import('../services/locale.service');
            await expect(initI18n()).resolves.toBeUndefined();
        });

        it('should be idempotent — calling twice does not throw', async () => {
            const { initI18n } = await import('../services/locale.service');
            await initI18n();
            await expect(initI18n()).resolves.toBeUndefined();
        });
    });

    describe('t — English (default)', () => {
        it('should return the English balance success string with interpolation', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            const result = t('balance.success', 'en', { balances: 'XLM: 42.00' });
            expect(result).toContain('42.00');
            expect(result).toContain('XLM');
        });

        it('should return the English unknown command string', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            expect(t('unknown.command', 'en')).toContain("didn't understand");
        });

        it('should return the English help text', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            expect(t('help.text', 'en')).toContain('Kolo Commands');
        });

        it('should return the English send success string with interpolation', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            const result = t('send.success', 'en', { amount: '10', target: '@jane' });
            expect(result).toContain('10');
            expect(result).toContain('@jane');
        });

        it('should return the English error.generic string', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            const result = t('error.generic', 'en', { message: 'DB failed' });
            expect(result).toContain('DB failed');
        });
    });

    describe('t — French', () => {
        it('should return French for balance.success', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            const result = t('balance.success', 'fr', { balances: 'XLM: 10' });
            expect(result).toContain('Soldes');
            expect(result).toContain('XLM: 10');
        });

        it('should return French for unknown.command', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            expect(t('unknown.command', 'fr')).toContain('compris');
        });

        it('should return French for help.text', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            expect(t('help.text', 'fr')).toContain('Commandes Kolo');
        });
    });

    describe('t — Yoruba', () => {
        it('should return Yoruba for balance.success', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            const result = t('balance.success', 'yo', { balances: 'XLM: 5' });
            expect(result).toContain('XLM');
        });

        it('should return Yoruba for help.text', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            expect(t('help.text', 'yo')).toContain('Kolo');
        });
    });

    describe('t — unsupported language falls back to English', () => {
        it('should fall back to English for an unknown language code', async () => {
            const { initI18n, t } = await import('../services/locale.service');
            await initI18n();
            const result = t('unknown.command', 'de');
            expect(result).toContain("didn't understand");
        });
    });

    describe('isSupportedLanguage', () => {
        it('should return true for en', async () => {
            const { initI18n, isSupportedLanguage } = await import('../services/locale.service');
            await initI18n();
            expect(isSupportedLanguage('en')).toBe(true);
        });

        it('should return true for fr', async () => {
            const { initI18n, isSupportedLanguage } = await import('../services/locale.service');
            await initI18n();
            expect(isSupportedLanguage('fr')).toBe(true);
        });

        it('should return true for yo', async () => {
            const { initI18n, isSupportedLanguage } = await import('../services/locale.service');
            await initI18n();
            expect(isSupportedLanguage('yo')).toBe(true);
        });

        it('should return false for an unsupported language', async () => {
            const { initI18n, isSupportedLanguage } = await import('../services/locale.service');
            await initI18n();
            expect(isSupportedLanguage('de')).toBe(false);
        });
    });
});
