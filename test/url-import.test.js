import { describe, it, expect, vi } from 'vitest';
import { formLogicFn } from '../src/components/formLogic.js';

const setup = (fetch = vi.fn()) => {
  const events = [];
  const window = { APP_TRANSLATIONS: { urlImportSuccess: 'success', urlImportFailure: 'failure' }, PREDEFINED_RULE_SETS: { balanced: ['Private'] }, location: { href: 'https://example.com/?configId=old' }, history: { replaceState: vi.fn() }, dispatchEvent: event => events.push(event) };
  const run = new Function('window', 'fetch', 'CustomEvent', `(${formLogicFn.toString()})(); return window.formData();`);
  const data = run(window, fetch, class { constructor(type, value) { this.type = type; this.detail = value.detail; } });
  return { data, events };
};
describe('explicit URL import', () => {
  for (const format of ['clash', 'singbox', 'surge', 'xray']) {
    it(`restores ${format} settings and clears stale configuration`, async () => {
      const { data, events } = setup();
      const params = new URLSearchParams({ config: 'https://source.example/sub?token=a%2Bb\nss://sample', selectedRules: '["Youtube"]', customRules: '[]', auto_exclude: '', exclude: 'US|JP', group_by_country: 'true' });
      data.urlToImport = `https://worker.example/${format}?${params}`;
      data.customUA = 'old'; data.remoteConfigUrl = 'https://old.example/config'; data.generatedLinks = { clash: 'old' };
      await data.importSubscriptionUrl();
      expect(data.input).toBe(params.get('config'));
      expect(data.selectedRules).toEqual(['Youtube']);
      expect(data.groupByCountry).toBe(true);
      expect(data.autoExcludeNodes).toBe('');
      expect(data.excludeNodes).toBe('US|JP');
      expect(data.customUA).toBe(''); expect(data.remoteConfigUrl).toBe('');
      expect(data.currentConfigId).toBe('');
      expect(data.generatedLinks).toBeNull();
      expect(events.at(-1).detail.rules).toEqual([]);
      expect(data.urlImportMessage).toBe('success');
    });
  }
  it('resolves instance short links and restores remote config', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ originalUrl: 'https://example.com/clash?config=source&remote_config=https%3A%2F%2Fremote.example%2Fa.ini' }) });
    const { data } = setup(fetch);
    data.urlToImport = 'https://example.com/c/code';
    await data.importSubscriptionUrl();
    expect(fetch).toHaveBeenCalledWith('/resolve?url=https%3A%2F%2Fexample.com%2Fc%2Fcode');
    expect(data.remoteConfigUrl).toBe('https://remote.example/a.ini');
    expect(data.selectedRules).toEqual(['Private']);
  });
  for (const url of ['ftp://example.com/clash?config=x', 'https://example.com/clash', 'https://example.com/clash?config=x&selectedRules=%7B%7D']) {
    it(`leaves the form unchanged for invalid input ${url}`, async () => {
      const { data } = setup(); data.input = 'original'; data.urlToImport = url;
      await data.importSubscriptionUrl();
      expect(data.input).toBe('original'); expect(data.urlImportError).toBe(true);
    });
  }
  it('ignores delayed short-link responses after the import URL changes', async () => {
    let finish;
    const { data } = setup(() => new Promise(resolve => { finish = resolve; }));
    data.input = 'original'; data.urlToImport = 'https://example.com/c/code';
    const pending = data.importSubscriptionUrl(); data.urlToImport = 'changed';
    finish({ ok: true, json: async () => ({ originalUrl: 'https://example.com/clash?config=old' }) });
    await pending; expect(data.input).toBe('original');
  });
});
