import { describe, it, expect, vi, afterEach } from 'vitest';
import { compileNodePattern } from '../src/services/nodeFilter.js';
import { applyRemoteRouting, loadRemoteRouting } from '../src/services/remoteConfigService.js';
import { createApp } from '../src/app/createApp.jsx';

const fixture = () => ({
    config: { proxies: [{name:'HK-A'}, {name:'JP-TYO-B'}, {name:'US-C'}], 'proxy-groups': [], rules: ['MATCH,DIRECT'] },
    getAllProviderNames: () => ['provider1'],
    getProviderNodeNames: () => ['HK-Remote','JP-TYO-Remote'],
    nodeExclusion: null
});
describe('remote routing and node filters', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('matches exclusion keywords without regex backtracking', () => {
        expect(compileNodePattern('剩余|套餐').test('剩余流量')).toBe(true);
        expect(compileNodePattern('剩余|套餐').test('HK-A')).toBe(false);
        expect(() => compileNodePattern('[')).toThrow();
        expect(() => compileNodePattern('a'.repeat(513))).toThrow();
    });
    it('imports INI references, filters, inline rules and classical rule providers', () => {
        const builder=fixture();
        applyRemoteRouting(builder, `[custom]\ncustom_proxy_group=HK\`url-test\`HK\`https://example.com/check\`300,,50\ncustom_proxy_group=YouTube\`select\`[]HK\`[]DIRECT\nruleset=YouTube,https://example.com/youtube.list\nruleset=DIRECT,[]GEOIP,CN\nruleset=YouTube,[]FINAL\nenable_rule_generator=true\noverwrite_original_rules=true`);
        const groups=builder.config['proxy-groups'];
        expect(groups.find(g=>g.name==='YouTube').proxies).toEqual(['HK','DIRECT']);
        expect(groups.find(g=>g.name==='YouTube').use).toBeUndefined();
        expect(groups.find(g=>g.name==='HK').filter).toBe('(?:HK)');
        expect(groups.find(g=>g.name==='HK').proxies).toEqual(['HK-A']);
        expect(builder.config.rules).toEqual(['RULE-SET,remote_rules_1,YouTube','GEOIP,CN,DIRECT','MATCH,YouTube']);
        expect(builder.config['rule-providers'].remote_rules_1.format).toBe('text');
    });
    it('supports the screenshot INI negative exclusion filter safely', () => {
        const builder=fixture();
        applyRemoteRouting(builder, '[custom]\ncustom_proxy_group=Auto`url-test`^(?!.*(US-LAX|JP-TYO)).*$`https://example.com/check`300,,50\nruleset=Auto,[]FINAL');
        const group=builder.config['proxy-groups'][0];
        expect(group.proxies).toEqual(['HK-A','US-C']);
        expect(group.filter).toBe('(?:.*)');
        expect(group['exclude-filter']).toBe('(?:US-LAX|JP-TYO)');
    });
    it('imports YAML routing while preserving source nodes and providers', () => {
        const builder=fixture(); builder.config['proxy-providers']={provider1:{url:'https://example.com/sub'}};
        applyRemoteRouting(builder, 'proxies: []\nproxy-groups:\n  - name: Remote\n    type: select\n    proxies: [DIRECT]\nrules:\n  - MATCH,Remote\nexternal-controller: 0.0.0.0:9090');
        expect(builder.config.proxies).toHaveLength(3);
        expect(builder.config['proxy-providers'].provider1).toBeDefined();
        expect(builder.config.rules).toEqual(['MATCH,Remote']);
        expect(builder.config['external-controller']).toBeUndefined();
    });
    it('rejects invalid group references and unsupported INI directives', () => {
        expect(()=>applyRemoteRouting(fixture(),'[custom]\ncustom_proxy_group=A`select`[]Missing\nruleset=A,[]FINAL')).toThrow();
        expect(()=>applyRemoteRouting(fixture(),'[custom]\nscript=execute')).toThrow();
    });
    it('rejects private config URLs and redirects before fetching', async () => {
        const fetchMock=vi.fn(); vi.stubGlobal('fetch',fetchMock);
        await expect(loadRemoteRouting('https://127.0.0.1/config.ini')).rejects.toThrow();
        expect(fetchMock).not.toHaveBeenCalled();
        fetchMock.mockResolvedValue(new Response(null,{status:302,headers:{Location:'https://192.168.0.1/config.ini'}}));
        await expect(loadRemoteRouting('https://example.com/config.ini')).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('applies exclusions through the actual Clash conversion endpoint', async () => {
        const app=createApp({logger:{error:()=>{}}});
        const source='vless://00000000-0000-4000-8000-000000000001@us.example.com:443?type=tcp#US-剩余流量\nvless://00000000-0000-4000-8000-000000000002@jp.example.com:443?type=tcp#JP-Node';
        const response=await app.request('/clash?config='+encodeURIComponent(source)+'&group_by_country=true&exclude='+encodeURIComponent('剩余'));
        expect(response.status).toBe(200);
        const config=(await import('js-yaml')).default.load(await response.text());
        expect(config.proxies.map(p=>p.name)).toEqual(['JP-Node']);
        expect(config['proxy-groups'].some(g=>g.name==='🇺🇸 United States')).toBe(false);
    });
    it('loads a remote profile through the actual Clash endpoint', async () => {
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('[custom]\ncustom_proxy_group=Remote`select`[]DIRECT\nruleset=Remote,[]FINAL')));
        const app=createApp({logger:{error:()=>{}}});
        const source='vless://00000000-0000-4000-8000-000000000001@example.com:443?type=tcp#HK-A';
        const response=await app.request('/clash?config='+encodeURIComponent(source)+'&remote_config='+encodeURIComponent('https://example.com/profile.ini'));
        expect(response.status).toBe(200);
        const config=(await import('js-yaml')).default.load(await response.text());
        expect(config.rules).toEqual(['MATCH,Remote']);
        expect(config['proxy-groups'].map(g=>g.name)).toEqual(['Remote']);
        expect(config.proxies).toHaveLength(1);
    });
    it('rejects malformed exclusion syntax with a 400 response', async () => {
        const app=createApp({logger:{error:()=>{}}});
        const response=await app.request('/clash?config=invalid&exclude=%5B');
        expect(response.status).toBe(400);
    });
    it('preserves the existing repository Xray subscription metadata behavior', async () => {
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('vless://example', {headers:{'subscription-userinfo':'upload=1; download=2; total=3'}})));
        const app=createApp({logger:{warn:()=>{}}});
        const response=await app.request('/xray?config='+encodeURIComponent('https://example.com/sub'));
        expect(response.status).toBe(200);
        expect(response.headers.get('subscription-userinfo')).toBe('upload=1; download=2; total=3');
    });
});
