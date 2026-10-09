/**
 * Syntax colors for the code blocks in chat answers (user request 08.10.2026; written here, no library): a small
 * tokenizer per language (JavaScript/TypeScript, Python, JSON, HTML/XML/SVG, CSS, Bash, PowerShell, SQL). Each rule is
 * a sticky regular expression tried in order at the current place; what no rule takes stays plain text. Everything is
 * HTML-escaped: the result holds only the code's text and <span class="hl-…"> around tokens.
 *   window.NedeseHighlight.highlight(code, lang) -> HTML string ('' language or unknown one: escaped text only)
 *   window.NedeseHighlight.language(lang) -> the language it is read as, or null
 */
(() => {
    const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const span = (type, text) => (type ? `<span class="hl-${type}">${escape(text)}</span>` : escape(text));
    const words = (list, flags = '') => new RegExp(`\\b(?:${list.split(' ').join('|')})\\b`, `y${flags}`);

    const JS_KEYWORDS = 'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield';
    const PY_KEYWORDS = 'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield';
    const SH_KEYWORDS = 'if then else elif fi for in do done while until case esac function return export local readonly declare set unset source alias exit break continue shift';
    const PS_KEYWORDS = 'begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using while';
    const SQL_KEYWORDS = 'add all alter and as asc begin between by case check column commit constraint create cross default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references replace returning right rollback select set table then transaction trigger union unique update using values view when where with count sum avg min max coalesce cast integer int text real varchar char boolean date timestamp autoincrement pragma';

    const NUMBER = /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)\b/y;
    const DQ = /"(?:\\[\s\S]|[^"\\\n])*"?/y;
    const SQ = /'(?:\\[\s\S]|[^'\\\n])*'?/y;
    const IDENT = /[A-Za-z_$][\w$]*/y;

    /** Inside an HTML/XML tag: its name, attribute names and values. */
    function tagHtml(text) {
        const m = /^(<\/?)([^\s/>]+)([\s\S]*?)(\/?>)$/.exec(text);
        if (!m) return span('tag', text);
        const attributes = m[3].replace(/([^\s=]+)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s"']+)?|[\s\S]/g, (all, name, eq, value) => (name ? span('attr', name) + escape(eq ?? '') + (value ? span('string', value) : '') : escape(all)));
        return span('tag', m[1] + m[2]) + attributes + span('tag', m[4]);
    }

    /** <script …>code or <style …>code: the opening tag, then the code as JavaScript or CSS. */
    function embedded(text) {
        const open = /^<[^>]*>/.exec(text)[0];
        return tagHtml(open) + highlight(text.slice(open.length), /^<style/i.test(open) ? 'css' : 'js');
    }

    const LANGUAGES = {
        js: [
            ['comment', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
            ['string', /`(?:\\[\s\S]|[^\\`])*`?/y],
            ['string', DQ],
            ['string', SQ],
            ['number', NUMBER],
            ['keyword', words(JS_KEYWORDS)],
            ['literal', words('true false null undefined NaN Infinity')],
            ['fn', /[A-Za-z_$][\w$]*(?=\s*\()/y],
            [null, IDENT],
        ],
        python: [
            ['comment', /#[^\n]*/y],
            ['string', /[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y],
            ['string', /[rRbBfFuU]{0,2}(?:"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?)/y],
            ['meta', /@[\w.]+/y],
            ['number', NUMBER],
            ['keyword', words(PY_KEYWORDS)],
            ['literal', words('True False None self cls')],
            ['fn', /[A-Za-z_]\w*(?=\s*\()/y],
            [null, /[A-Za-z_]\w*/y],
        ],
        json: [
            ['prop', /"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/y],
            ['string', DQ],
            ['number', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
            ['literal', words('true false null')],
        ],
        html: [
            ['comment', /<!--[\s\S]*?(?:-->|$)/y],
            ['meta', /<![^>]*>|<\?[\s\S]*?\?>/y],
            // a script or a style inside the page: its tag, then its code in its own colors (the closing tag follows)
            [embedded, /<(script|style)\b[^>]*>[\s\S]*?(?=<\/(?:script|style)\s*>|$)/iy],
            [tagHtml, /<\/?[A-Za-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/y],
            ['literal', /&(?:#\d+|#x[\da-fA-F]+|\w+);/y],
        ],
        css: [
            ['comment', /\/\*[\s\S]*?(?:\*\/|$)/y],
            ['string', DQ],
            ['string', SQ],
            ['keyword', /@[\w-]+|!important\b/y],
            // a property is followed by ":" and a value up to ";" or "}" (a selector's ":hover" goes on to "{")
            ['prop', /-{0,2}[A-Za-z][\w-]*(?=\s*:(?!:)[^;{}]*[;}])/y],
            ['number', /#[\da-fA-F]{3,8}\b|-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|s|ms|deg|rad|turn|fr|dpi|dppx)?\b/y],
            ['fn', /[A-Za-z-]+(?=\()/y],
            [null, /[\w-]+/y],
        ],
        bash: [
            ['comment', /#[^\n]*/y],
            ['string', DQ],
            ['string', /'[^']*'?/y],
            ['var', /\$(?:\{[^}\n]*\}?|[\w@#?$!*-])/y],
            ['keyword', words(SH_KEYWORDS)],
            ['attr', /(?<=\s)--?[A-Za-z][\w-]*/y],
            ['number', /\b\d+\b/y],
            [null, /[\w./-]+/y],
        ],
        powershell: [
            ['comment', /<#[\s\S]*?(?:#>|$)|#[^\n]*/y],
            ['string', /@"[\s\S]*?(?:\n"@|$)|@'[\s\S]*?(?:\n'@|$)/y],
            ['string', /"(?:`[\s\S]|[^"`])*"?/y],
            ['string', /'(?:''|[^'])*'?/y],
            ['var', /\$(?:\{[^}]*\}|(?:env|global|script|local|using):\w+|\w+)/y],
            ['keyword', /-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|and|or|not|xor|is|isnot|as|f)\b/iy],
            ['keyword', words(PS_KEYWORDS, 'i')],
            ['fn', /[A-Za-z]+-[A-Za-z][\w]*/y],
            ['attr', /(?<=\s)-[A-Za-z][\w]*/y],
            ['number', /\b\d+(?:\.\d+)?(?:kb|mb|gb|tb)?\b/iy],
            ['literal', /\$(?:true|false|null)\b/iy],
            [null, /[\w.]+/y],
        ],
        sql: [
            ['comment', /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
            ['string', /'(?:''|[^'])*'?/y],
            ['prop', /"(?:""|[^"])*"?|`[^`]*`?|\[[^\]\n]*\]/y],
            ['number', /\b\d+(?:\.\d+)?\b/y],
            ['literal', words('true false null', 'i')],
            ['keyword', words(SQL_KEYWORDS, 'i')],
            [null, /\w+/y],
        ],
    };
    const ALIASES = {
        javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', typescript: 'js', node: 'js',
        py: 'python', python3: 'python', jsonc: 'json', json5: 'json', jsonl: 'json',
        xml: 'html', svg: 'html', xhtml: 'html', htm: 'html', vue: 'html',
        scss: 'css', less: 'css',
        sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', shellscript: 'bash',
        ps: 'powershell', ps1: 'powershell', pwsh: 'powershell', psm1: 'powershell',
        sqlite: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', psql: 'sql', plsql: 'sql', tsql: 'sql',
    };

    function language(lang) {
        const l = String(lang ?? '').trim().toLowerCase();
        if (LANGUAGES[l]) return l;
        return ALIASES[l] ?? null;
    }

    function highlight(code, lang) {
        const text = String(code ?? '');
        const rules = LANGUAGES[language(lang)];
        // a very long block is shown plain (the tokenizer would hold up the page)
        if (!rules || text.length > 200000) return escape(text);
        let out = '';
        let plain = '';
        let at = 0;
        while (at < text.length) {
            let taken = false;
            for (const [type, re] of rules) {
                re.lastIndex = at;
                const m = re.exec(text);
                if (!m || !m[0]) continue;
                out += escape(plain);
                plain = '';
                out += typeof type === 'function' ? type(m[0]) : span(type, m[0]);
                at += m[0].length;
                taken = true;
                break;
            }
            if (!taken) plain += text[at++];
        }
        return out + escape(plain);
    }

    window.NedeseHighlight = { highlight, language };
})();
