import { RE2JS } from 're2js';
import { InvalidPayloadError } from './errors.js';

export function compileNodePattern(source = '') {
    if (!source) return null;
    if (typeof source !== 'string' || source.length > 512) throw new InvalidPayloadError('Node filter must be at most 512 characters');
    try {
        const pattern = RE2JS.compile(source);
        return { source, test: name => typeof name === 'string' && pattern.matcher(name).find() };
    } catch (_) {
        throw new InvalidPayloadError('Invalid node filter: use keywords separated by | or an RE2-compatible regular expression');
    }
}

export function compileRemotePattern(source) {
    const prefix = source.startsWith('(?i)') ? '(?i)' : '';
    const raw = prefix ? source.slice(4) : source;
    // This common Subconverter exclusion has a linear-time include/exclude equivalent.
    const negative = raw.match(/^\^\(\?!\.\*\((.+)\)\)\.\*\$$/);
    const include = negative ? '.*' : source;
    const exclude = negative ? prefix + negative[1] : '';
    const positivePattern = compileNodePattern(include);
    const negativePattern = compileNodePattern(exclude);
    return { include, exclude, test: name => positivePattern.test(name) && !negativePattern?.test(name) };
}
