import { describe, it, expect } from 'vitest';
import { formLogicFn } from '../src/components/formLogic.js';

describe('formLogic toString fix', () => {
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
});
