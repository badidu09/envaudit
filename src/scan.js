import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, extname, join, relative, sep } from 'node:path';

const NAME = '([A-Za-z_][A-Za-z0-9_]*)';
const STR = `['"\`]${NAME}['"\`]`;
const DQ = `"${NAME}"`;

const JS_RULES = [
  new RegExp(`\\b(?:process\\.env|import\\.meta\\.env|Bun\\.env)\\??\\.${NAME}`, 'g'),
  new RegExp(`\\b(?:process\\.env|import\\.meta\\.env|Bun\\.env)\\??\\.?\\[\\s*${STR}\\s*\\]`, 'g'),
  new RegExp(`\\bDeno\\.env\\.get\\(\\s*${STR}`, 'g'),
];
const RULES_BY_EXTENSION = {
  python: [
    new RegExp(`\\bos\\.environ\\[\\s*${STR}`, 'g'),
    new RegExp(`\\bos\\.environ\\.get\\(\\s*${STR}`, 'g'),
    new RegExp(`\\bos\\.getenv\\(\\s*${STR}`, 'g'),
  ],
  go: [new RegExp(`\\bos\\.(?:Getenv|LookupEnv)\\(\\s*${DQ}`, 'g')],
  rust: [
    new RegExp(`\\benv::var(?:_os)?\\(\\s*${DQ}`, 'g'),
    new RegExp(`\\b(?:option_)?env!\\(\\s*${DQ}`, 'g'),
  ],
  ruby: [new RegExp(`\\bENV(?:\\.fetch\\(|\\[)\\s*${STR}`, 'g')],
  php: [
    new RegExp(`\\b(?:getenv|env)\\(\\s*${STR}`, 'g'),
    new RegExp(`\\$_ENV\\[\\s*${STR}`, 'g'),
  ],
  java: [new RegExp(`\\bSystem\\.getenv\\(\\s*${DQ}`, 'g')],
  csharp: [new RegExp(`\\bEnvironment\\.GetEnvironmentVariable\\(\\s*${DQ}`, 'g')],
  compose: [new RegExp(`\\$\\{${NAME}(?:[:?+-][^}]*)?\\}`, 'g')],
};
const LANGUAGE_BY_EXTENSION = {
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
  '.java': 'java', '.kt': 'java', '.cs': 'csharp',
};
const JS_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro',
]);
const COMPOSE_FILE = /^(docker-)?compose([.-].+)?\.ya?ml$/i;
const DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env|Bun\.env)\b/g;

const SKIPPED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', 'venv', '__pycache__',
]);
const MAX_FILE_BYTES = 1024 * 1024;

function isSkippedPath(path) {
  return path.split('/').some((part) => SKIPPED_DIRS.has(part) || part.startsWith('.'));
}

function isScannable(path) {
  const name = basename(path);
  const extension = extname(name);
  return JS_EXTENSIONS.has(extension) || extension in LANGUAGE_BY_EXTENSION || COMPOSE_FILE.test(name);
}

function walk(root, dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, files);
    else if (entry.isFile()) files.push(relative(root, full).split(sep).join('/'));
  }
  return files;
}

/** Lists candidate source files, honouring .gitignore inside a git repository. */
export function listSourceFiles(root) {
  const git = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const files = git.status === 0 ? git.stdout.split('\0').filter(Boolean) : walk(root, root, []);
  return files.filter((file) => !isSkippedPath(file) && isScannable(file)).sort();
}

function rulesFor(file) {
  const name = basename(file);
  if (COMPOSE_FILE.test(name)) return RULES_BY_EXTENSION.compose;
  const extension = extname(name);
  if (JS_EXTENSIONS.has(extension)) return JS_RULES;
  return RULES_BY_EXTENSION[LANGUAGE_BY_EXTENSION[extension]] ?? [];
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/** Finds the variable names read in one file's source. */
export function findVariables(file, text) {
  const found = [];
  for (const rule of rulesFor(file)) {
    for (const match of text.matchAll(rule)) {
      found.push({ name: match[1], line: lineAt(text, match.index) });
    }
  }
  if (JS_EXTENSIONS.has(extname(file))) {
    for (const match of text.matchAll(DESTRUCTURE)) {
      const line = lineAt(text, match.index);
      const body = match[1].replace(/\/\*.*?\*\/|\/\/.*$/gm, '');
      for (const part of body.split(',')) {
        const key = part.trim();
        if (key.startsWith('...')) continue;
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(key)?.[0];
        if (name) found.push({ name, line });
      }
    }
  }
  return found;
}

/** Scans a project and maps each variable to the places that read it. */
export function scanProject(root) {
  const usages = new Map();
  const files = listSourceFiles(root);
  let scanned = 0;

  for (const file of files) {
    const full = join(root, file);
    let text;
    try {
      if (statSync(full).size > MAX_FILE_BYTES) continue;
      text = readFileSync(full, 'utf8');
    } catch {
      continue; // Tracked but deleted from the working tree.
    }
    scanned++;
    for (const { name, line } of findVariables(file, text)) {
      if (!usages.has(name)) usages.set(name, []);
      usages.get(name).push({ file, line });
    }
  }

  return { usages, scanned };
}
