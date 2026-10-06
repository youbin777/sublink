import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { createApp } from '../src/app/createApp.jsx';

const source = ['US-LAX-01', 'JP-剩余流量', 'SG-Node'].map((name, index) =>
    `ss://YWVzLTI1Ni1nY206dGVzdA==@host${index}.example.com:8388#${encodeURIComponent(name)}`).join('\n');
const app = createApp({ logger: { error: () => {}, warn: () => {} } });
describe('Cross-format exclusions', () => {
    for (const format of ['singbox', 'surge']) {
        it(`does not restore excluded auto candidates or fall back to direct in ${format}`, async () => {
            const params = new URLSearchParams({ config: source, auto_exclude: '.*' });
            const response = await app.request(`/${format}?${params}`);
            expect(response.status).toBe(200);
            const text = await response.text();
            if (format === 'singbox') {
                const config = JSON.parse(text);
                expect(config.outbounds.find(o => o.type === 'urltest').outbounds).toEqual(['REJECT']);
                expect(config.outbounds.some(o => o.tag === 'SG-Node')).toBe(true);
            } else {
                const auto = text.split('\n').find(line => line.startsWith('⚡ 自动选择 ='));
                expect(auto).toContain('REJECT');
                expect(auto).not.toContain('SG-Node');
                expect(auto).not.toContain('DIRECT');
            }
        });
    }
    for (const format of ['xray', 'singbox', 'clash', 'surge']) {
        it(`filters node names in ${format} and keeps auto-excluded nodes for manual use`, async () => {
            const params = new URLSearchParams({ config: source, exclude: '剩余', auto_exclude: 'US-LAX' });
            const response = await app.request(`/${format}?${params}`);
            expect(response.status).toBe(200);
            const text = await response.text();
            if (format === 'xray') {
                const decoded = atob(text);
                expect(decoded).not.toContain(encodeURIComponent('JP-剩余流量'));
                expect(decoded).toContain('US-LAX-01');
                expect(decoded).toContain('SG-Node');
            } else if (format === 'singbox') {
                const config = JSON.parse(text);
                const auto = config.outbounds.find(o => o.type === 'urltest' && o.tag.includes('自动选择'));
                expect(config.outbounds.some(o => o.tag === 'JP-剩余流量')).toBe(false);
                expect(config.outbounds.some(o => o.tag === 'US-LAX-01')).toBe(true);
                expect(auto.outbounds).toEqual(['SG-Node']);
            } else if (format === 'surge') {
                expect(text).not.toContain('JP-剩余流量');
                expect(text).toContain('US-LAX-01 =');
                const auto = text.split('\n').find(line => line.startsWith('⚡ 自动选择 ='));
                expect(auto).toContain('SG-Node');
                expect(auto).not.toContain('US-LAX');
            } else {
                const config = yaml.load(text);
                expect(config.proxies.some(o => o.name === 'JP-剩余流量')).toBe(false);
                expect(config.proxies.some(o => o.name === 'US-LAX-01')).toBe(true);
                expect(config['proxy-groups'].find(o => o.name.includes('自动选择'))['exclude-filter']).toBe('US-LAX');
            }
        });
        it(`rejects malformed node filters in ${format}`, async () => {
            const response = await app.request(`/${format}?config=${encodeURIComponent(source)}&exclude=%5B`);
            expect(response.status).toBe(400);
        });
    }
});
