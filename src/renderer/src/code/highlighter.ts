import type { CodeHighlightAdapter } from '@mantine/code-highlight'

/**
 * highlight.js with only the languages Mainbus shows, loaded on first use into a chunk of their own. It marks tokens
 * with `hljs-*` classes, which `CodeBlock.module.css` colours from the theme's `--mainbus-code-*` variables.
 *
 * A language it doesn't know is not highlighted (never passed to `highlight`, which throws on one): the code then
 * renders as text, which React escapes.
 */
export const highlightAdapter: CodeHighlightAdapter = {
  loadContext: async () => {
    const [{ default: hljs }, ts, js, json, bash, powershell, sql, css, markdown, yaml, diff] = await Promise.all([
      import('highlight.js/lib/core'),
      import('highlight.js/lib/languages/typescript'),
      import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/bash'),
      import('highlight.js/lib/languages/powershell'),
      import('highlight.js/lib/languages/sql'),
      import('highlight.js/lib/languages/css'),
      import('highlight.js/lib/languages/markdown'),
      import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/diff')
    ])
    hljs.registerLanguage('typescript', ts.default)
    hljs.registerLanguage('javascript', js.default)
    hljs.registerLanguage('json', json.default)
    hljs.registerLanguage('bash', bash.default)
    hljs.registerLanguage('powershell', powershell.default)
    hljs.registerLanguage('sql', sql.default)
    hljs.registerLanguage('css', css.default)
    hljs.registerLanguage('markdown', markdown.default)
    hljs.registerLanguage('yaml', yaml.default)
    hljs.registerLanguage('diff', diff.default)
    return hljs
  },
  getHighlighter: (hljs: typeof import('highlight.js/lib/core').default | undefined) => ({ code, language }) => {
    if (!hljs || !language || !hljs.getLanguage(language)) return { highlightedCode: code, isHighlighted: false }
    return { highlightedCode: hljs.highlight(code, { language, ignoreIllegals: true }).value, isHighlighted: true, codeElementProps: { className: 'hljs' } }
  }
}
