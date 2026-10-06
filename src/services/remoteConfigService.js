import yaml from 'js-yaml';
import { InvalidPayloadError } from './errors.js';
import { compileNodePattern, compileRemotePattern } from './nodeFilter.js';
import { createStableProviderName } from '../utils.js';

const MAX_BYTES = 1024 * 1024;
const GROUP_TYPES = new Set(['select', 'url-test', 'fallback', 'load-balance']);
const SPECIAL_NAMES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];

function publicHttpsUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new InvalidPayloadError('Remote configuration requires a valid HTTPS URL'); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        !host.includes('.') || host.startsWith('[') || /(^|\.)(localhost|local|internal)$/.test(host) ||
        /^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host) ||
        /^(22[4-9]|23\d|24\d|25[0-5])\./.test(host)) {
        throw new InvalidPayloadError('Remote configuration must use a public HTTPS address without embedded credentials');
    }
    return url;
}

export async function loadRemoteRouting(value) {
    let url = publicHttpsUrl(value);
    for (let hop = 0; hop <= 3; hop++) {
        let response;
        try { response = await fetch(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
        catch (_) { throw new InvalidPayloadError('Could not fetch remote configuration'); }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location || hop === 3) throw new InvalidPayloadError('Invalid remote configuration redirect');
            url = publicHttpsUrl(new URL(location, url).toString());
            continue;
        }
        if (!response.ok) throw new InvalidPayloadError(`Remote configuration returned HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new InvalidPayloadError('Remote configuration exceeds 1 MiB');
        const reader = response.body?.getReader();
        if (!reader) throw new InvalidPayloadError('Remote configuration is empty');
        const decoder = new TextDecoder();
        let total = 0, text = '';
        while (true) {
            const { value: chunk, done } = await reader.read();
            if (done) break;
            total += chunk.byteLength;
            if (total > MAX_BYTES) { await reader.cancel(); throw new InvalidPayloadError('Remote configuration exceeds 1 MiB'); }
            text += decoder.decode(chunk, { stream: true });
        }
        return text + decoder.decode();
    }
    throw new InvalidPayloadError('Too many remote configuration redirects');
}

function parseIni(text, builder) {
    let inCustom = false;
    const declarations = [], ruleDefinitions = [];
    const flags = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;
        if (line.length > 16384) throw new InvalidPayloadError('Remote configuration line is too long');
        if (/^\[.*\]$/.test(line)) {
            if (line.toLowerCase() !== '[custom]') throw new InvalidPayloadError('Only [custom] Subconverter profiles are supported');
            inCustom = true; continue;
        }
        if (!inCustom) throw new InvalidPayloadError('INI configuration requires a [custom] section');
        const equals = line.indexOf('=');
        if (equals < 1) throw new InvalidPayloadError('Invalid INI directive');
        const key = line.slice(0, equals).trim(), value = line.slice(equals + 1).trim();
        if (key === 'custom_proxy_group') declarations.push(value);
        else if (key === 'ruleset') ruleDefinitions.push(value);
        else if (['enable_rule_generator', 'overwrite_original_rules'].includes(key)) {
            if (!['true','false'].includes(value)) throw new InvalidPayloadError(`Invalid ${key} flag`);
            flags[key] = value === 'true';
        } else throw new InvalidPayloadError(`Unsupported remote INI directive: ${key}`);
    }
    if (declarations.length > 512 || ruleDefinitions.length > 2048) throw new InvalidPayloadError('Remote profile has too many groups or rulesets');
    const providerNames = builder.getAllProviderNames();
    const inlineNames = (builder.config.proxies || []).map(p => p.name).filter(name => typeof name === 'string');
    const groups = declarations.map(value => {
        const parts = value.split('`');
        const name = parts.shift(), type = parts.shift();
        if (!name || !GROUP_TYPES.has(type)) throw new InvalidPayloadError('Unsupported remote proxy group type');
        const group = { name, type, proxies: [] };
        if (type !== 'select') {
            if (parts.length < 3) throw new InvalidPayloadError(`Missing health check for group ${name}`);
            const timing = parts.pop().split(',');
            group.interval = Number(timing[0]);
            if (!Number.isFinite(group.interval) || group.interval < 1 || group.interval > 86400) throw new InvalidPayloadError('Invalid remote group interval');
            if (timing[2]) { group.tolerance = Number(timing[2]); if (!Number.isFinite(group.tolerance) || group.tolerance < 0) throw new InvalidPayloadError('Invalid tolerance'); }
            group.url = parts.pop();
            let healthUrl;
            try { healthUrl = new URL(group.url); } catch (_) { throw new InvalidPayloadError('Invalid group health-check URL'); }
            if (!['http:','https:'].includes(healthUrl.protocol)) throw new InvalidPayloadError('Invalid group health-check scheme');
            group.lazy = true;
        }
        const patterns = [];
        for (const entry of parts) {
            if (entry.startsWith('[]')) group.proxies.push(entry.slice(2));
            else if (entry) patterns.push(compileRemotePattern(entry));
        }
        if (patterns.length > 1 && patterns.some(p => p.exclude)) throw new InvalidPayloadError('Combine negative exclusion into a single remote group expression');
        group.proxies.push(...inlineNames.filter(node => patterns.some(pattern => pattern.test(node))));
        group.proxies = [...new Set(group.proxies)];
        if (patterns.length && providerNames.length) {
            group.use = providerNames;
            group.filter = patterns.map(p => `(?:${p.include})`).join('|');
            const excluded = patterns.map(p => p.exclude).filter(Boolean);
            if (excluded.length) group['exclude-filter'] = excluded.map(p => `(?:${p})`).join('|');
        }
        return group;
    });
    const rules = [], providers = {};
    for (const definition of ruleDefinitions) {
        const comma = definition.indexOf(',');
        if (comma < 1) throw new InvalidPayloadError('Invalid remote ruleset declaration');
        const target = definition.slice(0,comma).trim(), source = definition.slice(comma+1).trim();
        if (source.startsWith('[]')) {
            const rule = source.slice(2), fields = rule.split(',');
            if (fields[0] === 'FINAL' || fields[0] === 'MATCH') rules.push(`MATCH,${target}`);
            else {
                if (!/^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|DOMAIN-REGEX|GEOSITE|GEOIP|IP-CIDR|IP-CIDR6|SRC-IP-CIDR|DST-PORT|SRC-PORT|NETWORK|PROCESS-NAME|PROCESS-PATH)$/.test(fields[0]) || fields.length < 2) throw new InvalidPayloadError('Unsupported inline remote rule');
                rules.push(`${fields[0]},${fields[1]},${target}${fields.slice(2).length ? ','+fields.slice(2).join(',') : ''}`);
            }
        } else {
            const url = publicHttpsUrl(source).toString(), id = `remote_rules_${Object.keys(providers).length+1}`;
            providers[id] = { type:'http', behavior:'classical', format:'text', url, path:`./ruleset/${createStableProviderName(url)}.list`, interval:86400 };
            rules.push(`RULE-SET,${id},${target}`);
        }
    }
    if (flags.enable_rule_generator === false) throw new InvalidPayloadError('Remote INI profile must enable rule generation');
    return { groups, rules, providers, overwrite: flags.overwrite_original_rules !== false };
}

function validateRouting(config, builder) {
    const groups = config['proxy-groups'];
    if (!Array.isArray(groups) || groups.length > 512) throw new InvalidPayloadError('Invalid remote proxy groups');
    const names = groups.map(g => g?.name);
    if (names.some(name => typeof name !== 'string' || !name.trim()) || new Set(names).size !== names.length) throw new InvalidPayloadError('Remote group names must be unique non-empty strings');
    const valid = new Set([...SPECIAL_NAMES,...names,...(config.proxies || []).map(p=>p.name),...builder.getProviderNodeNames()]);
    const providers = new Set(builder.getAllProviderNames());
    for (const group of groups) {
        if (!GROUP_TYPES.has(group.type)) throw new InvalidPayloadError('Unsupported remote group type');
        if (group.proxies && (!Array.isArray(group.proxies) || group.proxies.some(name=>typeof name!=='string' || !valid.has(name)))) throw new InvalidPayloadError(`Invalid member in remote group ${group.name}`);
        if (group.use && (!Array.isArray(group.use) || group.use.some(name=>!providers.has(name)))) throw new InvalidPayloadError(`Invalid provider in remote group ${group.name}`);
        if (!builder.config['proxy-groups']?.includes(group)) {
            if (group.filter) compileNodePattern(group.filter);
            if (group['exclude-filter']) compileNodePattern(group['exclude-filter']);
        }
        if (!(group.proxies?.length || group.use?.length || group['include-all'] || group['include-all-providers'] || group['include-all-proxies'])) throw new InvalidPayloadError(`Remote group ${group.name} has no members`);
    }
    const visited = new Set(), active = new Set(), byName = new Map(groups.map(g=>[g.name,g]));
    const visit = name => {
        if (active.has(name)) throw new InvalidPayloadError('Remote profile has a proxy-group cycle');
        if (visited.has(name)) return;
        active.add(name);
        for (const member of byName.get(name)?.proxies || []) if (byName.has(member)) visit(member);
        active.delete(name); visited.add(name);
    };
    names.forEach(visit);
    if (!Array.isArray(config.rules) || !config.rules.length || config.rules.length > 10000) throw new InvalidPayloadError('Remote profile requires routing rules');
    for (const rule of config.rules) {
        if (typeof rule !== 'string') throw new InvalidPayloadError('Invalid remote rule');
        const fields = rule.split(',');
        const target = fields[fields.length-1] === 'no-resolve' ? fields[fields.length-2] : fields[fields.length-1];
        if (!new Set([...SPECIAL_NAMES,...names]).has(target)) throw new InvalidPayloadError(`Remote rule refers to an unknown policy`);
        if (fields[0] === 'RULE-SET' && !config['rule-providers']?.[fields[1]]) throw new InvalidPayloadError('Remote rule refers to an unknown ruleset');
    }
}

export function applyRemoteRouting(builder, text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES) throw new InvalidPayloadError('Invalid remote configuration size');
    const content = text.replace(/^\uFEFF/,'').trim();
    let candidate = { ...builder.config };
    if (/^\s*\[custom\]/im.test(content)) {
        const parsed = parseIni(content,builder);
        candidate['proxy-groups'] = parsed.groups;
        candidate['rule-providers'] = parsed.overwrite ? parsed.providers : {...candidate['rule-providers'],...parsed.providers};
        candidate.rules = parsed.overwrite ? parsed.rules : [...parsed.rules.filter(r=>!r.startsWith('MATCH,')),...candidate.rules];
    } else {
        let parsed;
        try { parsed = yaml.load(content); } catch (_) { throw new InvalidPayloadError('Remote configuration is not valid INI or Clash YAML'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvalidPayloadError('Remote Clash configuration must be an object');
        // Import routing only; nodes and connection/control settings remain locally owned.
        if (parsed['proxy-groups']) candidate['proxy-groups'] = parsed['proxy-groups'];
        if (parsed.rules) candidate.rules = parsed.rules;
        if (parsed['rule-providers']) candidate['rule-providers'] = parsed['rule-providers'];
        if (!parsed.rules && !parsed['proxy-groups']) throw new InvalidPayloadError('Remote Clash configuration has no routing rules or groups');
        for (const provider of Object.values(candidate['rule-providers'] || {})) if (provider.url) publicHttpsUrl(provider.url);
    }
    validateRouting(candidate,builder);
    builder.config = candidate;
    return yaml.dump(candidate);
}
