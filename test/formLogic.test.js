import { describe, it, expect, vi } from 'vitest';
import { formLogicFn } from '../src/components/formLogic.js';

describe('formLogic toString fix', () => {
  const makeData = ({document={},navigator={},fetch=()=>{}}={}) => {
    const window={APP_TRANSLATIONS:{},PREDEFINED_RULE_SETS:{},navigator,location:{origin:'https://example.com',search:''}};
    const doc={querySelector:()=>({value:'[]'}),getElementById:()=>null,...document};
    const run=new Function('window','document','setTimeout','clearTimeout','fetch','alert','('+formLogicFn.toString()+')(); return window.formData();');
    const data=run(window,doc,()=>{},()=>{},fetch,()=>{});
    data.input='test-source'; return data;
  };
  it('includes parseSurgeConfigInput definition in toString output', () => {
    const fnString = formLogicFn.toString();

    // Verify the function references parseSurgeConfigInput
    expect(fnString).toContain('parseSurgeConfigInput');

    // Verify the arrow function definitions ARE included
    expect(fnString).toMatch(/(?:const|var|let)\s+parseSurgeConfigInput\s*=/);
    expect(fnString).toMatch(/(?:const|var|let)\s+parseSurgeValue\s*=/);
    expect(fnString).toMatch(/(?:const|var|let)\s+convertSurgeIniToJson\s*=/);
  });

  it('does not contain __name calls that break in browser runtime', () => {
    const fnString = formLogicFn.toString();
    // Ensure no function declarations that esbuild would inject __name() for
    expect(fnString).not.toMatch(/^\s*function\s+parseSurgeValue\b/m);
    expect(fnString).not.toMatch(/^\s*function\s+convertSurgeIniToJson\b/m);
    expect(fnString).not.toMatch(/^\s*function\s+parseSurgeConfigInput\b/m);
  });

  it('formData() returns a valid Alpine data object', () => {
    // Simulate browser global environment using Function constructor
    const fakeWindow = { APP_TRANSLATIONS: {}, PREDEFINED_RULE_SETS: {} };
    const fn = new Function('window', '(' + formLogicFn.toString() + ')(); return window;');
    const result = fn(fakeWindow);
    const data = result.formData();
    expect(typeof data.submitForm).toBe('function');
    expect(typeof data.toggleAccordion).toBe('function');
    expect(data.showAdvanced).toBe(false);
  });

  it('generates encoded exclusion and remote profile parameters only for Clash', async () => {
    const fakeWindow={APP_TRANSLATIONS:{},PREDEFINED_RULE_SETS:{},location:{origin:'https://example.com',search:''}};
    const fakeDocument={querySelector:()=>({value:'[]'})};
    const run=new Function('window','document','setTimeout','('+formLogicFn.toString()+')(); return window.formData();');
    const data=run(fakeWindow,fakeDocument,()=>{});
    data.input='test-source'; data.excludeNodes='剩余|套餐'; data.remoteConfigUrl='https://example.com/profile.ini?version=1&mode=full';
    await data.submitForm();
    expect(new URL(data.generatedLinks.clash).searchParams.get('exclude')).toBe('剩余|套餐');
    expect(new URL(data.generatedLinks.clash).searchParams.get('remote_config')).toBe(data.remoteConfigUrl);
    expect(new URL(data.generatedLinks.singbox).searchParams.has('remote_config')).toBe(false);
    expect(new URL(data.generatedLinks.surge).searchParams.has('exclude')).toBe(false);
  });

  it('uses the current remote address control even before model state catches up', async () => {
    const field={value:'https://example.com/new.ini'};
    const data=makeData({document:{getElementById:id=>id==='remoteConfigUrl'?field:null}});
    data.remoteConfigUrl='https://example.com/old.ini';
    await data.submitForm();
    expect(new URL(data.generatedLinks.clash).searchParams.get('remote_config')).toBe(field.value);
    expect(data.generatedRemoteConfigUrl).toBe(field.value);
  });

  it('ignores an old short-link response after converting with a new remote address', async () => {
    let release;
    const fetchMock=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>release=resolve)).mockImplementation(async()=>new Response('oldcode'));
    const data=makeData({fetch:fetchMock});
    data.remoteConfigUrl='https://example.com/old.ini'; await data.submitForm();
    const oldRequest=data.shortenLinks();
    data.remoteConfigUrl='https://example.com/new.ini'; await data.submitForm();
    release(new Response('oldcode')); await oldRequest;
    expect(data.shortenedLinks).toBeNull();
    expect(new URL(data.generatedLinks.clash).searchParams.get('remote_config')).toBe('https://example.com/new.ini');
  });

  it('copies the latest displayed URL and reports success only after the clipboard resolves', async () => {
    const writeText=vi.fn().mockResolvedValue(undefined);
    const data=makeData({navigator:{clipboard:{writeText}}});
    data.generatedLinks={clash:'https://example.com/latest'};
    expect(await data.copyLink('clash')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://example.com/latest');
    expect(data.copiedLink).toBe('clash');
  });

  it('selects the URL for manual copying when clipboard and fallback are unavailable', async () => {
    const input={value:'',focus:vi.fn(),select:vi.fn(),setSelectionRange:vi.fn()};
    const data=makeData({navigator:{clipboard:{writeText:vi.fn().mockRejectedValue(Error('denied'))}},document:{getElementById:()=>input,execCommand:()=>false}});
    data.generatedLinks={clash:'https://example.com/latest'};
    expect(await data.copyLink('clash')).toBe(false);
    expect(data.copiedLink).toBeNull();
    expect(input.value).toBe('https://example.com/latest');
    expect(input.select).toHaveBeenCalled();
    expect(data.copyError).toBeTruthy();
  });
});
