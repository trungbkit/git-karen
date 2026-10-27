// File name → Shiki language id. Each language is loaded lazily as its own chunk.

type Loader = () => Promise<{ default: unknown }>

/**
 * Grammar loaders. Kept as explicit `import()` calls so Vite can split every grammar into its own chunk
 * (a template-string import would not be analysable for bare package paths).
 */
export const LANGUAGE_LOADERS: Record<string, Loader> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  objc: () => import('shiki/langs/objective-c.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  clojure: () => import('shiki/langs/clojure.mjs'),
  erlang: () => import('shiki/langs/erlang.mjs'),
  terraform: () => import('shiki/langs/terraform.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  'git-commit': () => import('shiki/langs/git-commit.mjs'),
  ignore: () => import('shiki/langs/codeowners.mjs')
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  json: 'json', json5: 'jsonc', jsonc: 'jsonc',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'html', htm: 'html', xhtml: 'html',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  py: 'python', pyi: 'python', pyw: 'python',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  m: 'objc', mm: 'objc',
  cs: 'csharp', php: 'php',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'shellscript', ksh: 'shellscript',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  yml: 'yaml', yaml: 'yaml', toml: 'toml',
  sql: 'sql',
  dockerfile: 'docker',
  mk: 'make', mak: 'make',
  xml: 'xml', svg: 'xml', plist: 'xml', xsd: 'xml', xsl: 'xml', csproj: 'xml',
  graphql: 'graphql', gql: 'graphql',
  lua: 'lua', dart: 'dart', scala: 'scala', sc: 'scala',
  ex: 'elixir', exs: 'elixir',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini',
  diff: 'diff', patch: 'diff',
  pl: 'perl', pm: 'perl', r: 'r',
  hs: 'haskell', clj: 'clojure', cljs: 'clojure', edn: 'clojure', erl: 'erlang',
  tf: 'terraform', tfvars: 'terraform', prisma: 'prisma', proto: 'proto', zig: 'zig'
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'docker',
  containerfile: 'docker',
  makefile: 'make',
  gnumakefile: 'make',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.npmignore': 'ignore',
  '.gitattributes': 'ignore',
  '.gitconfig': 'ini',
  '.gitmodules': 'ini',
  '.npmrc': 'ini',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  '.profile': 'shellscript',
  '.env': 'shellscript',
  commit_editmsg: 'git-commit',
  'tsconfig.json': 'jsonc',
  'jsconfig.json': 'jsonc',
  '.eslintrc': 'jsonc',
  '.babelrc': 'jsonc'
}

/** Returns the Shiki language id for a file path, or null when it should not be highlighted. */
export function languageForPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? path
  const lower = base.toLowerCase()
  if (BY_NAME[lower]) return BY_NAME[lower]
  if (lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile')) return 'docker'
  if (lower.startsWith('.env.')) return 'shellscript'
  const dot = lower.lastIndexOf('.')
  if (dot <= 0 && !lower.startsWith('.')) return null
  const ext = lower.slice(dot + 1)
  return BY_EXTENSION[ext] ?? null
}
