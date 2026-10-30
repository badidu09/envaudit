import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseDotenv } from './dotenv.js';
import { detectSecret } from './secrets.js';
import { scanProject } from './scan.js';

export const EXAMPLE_CANDIDATES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
export const DEFAULT_ENV_FILES = ['.env', '.env.local'];

// Set by the OS, the runtime or the bundler rather than by a project's .env.
const BUILTINS = new Set([
  'NODE_ENV', 'CI', 'HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'LANG', 'TMP', 'TEMP', 'TMPDIR',
  'HOSTNAME', 'NO_COLOR', 'MODE', 'BASE_URL', 'PROD', 'DEV', 'SSR', 'npm_package_version',
]);

function compileIgnore(patterns) {
  const exact = new Set(patterns.filter((p) => !p.endsWith('*')));
  const prefixes = patterns.filter((p) => p.endsWith('*')).map((p) => p.slice(0, -1));
  return (name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

function checkGitExposure(root, file) {
  const run = (...args) => spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status;
  if (run('ls-files', '--error-unmatch', '--', file) === 0) {
    return `${file} is tracked by git: remove it with "git rm --cached ${file}" and rotate its secrets`;
  }
  if (run('check-ignore', '-q', '--', file) === 1) {
    return `${file} is not in .gitignore and could be committed by accident`;
  }
  return null;
}

/** Runs every check against a project directory and returns its findings. */
export function audit(root, options = {}) {
  const { example: exampleOption, envFiles = DEFAULT_ENV_FILES, ignore = [] } = options;
  const isIgnored = compileIgnore(ignore);
  const exampleFile = exampleOption ?? EXAMPLE_CANDIDATES.find((f) => existsSync(join(root, f))) ?? null;
  const example = exampleFile
    ? parseDotenv(readFileSync(join(root, exampleFile), 'utf8'))
    : { entries: new Map(), duplicates: [] };
  const presentEnvFiles = envFiles.filter((f) => existsSync(join(root, f)));
  const localNames = new Set(
    presentEnvFiles.flatMap((f) => [...parseDotenv(readFileSync(join(root, f), 'utf8')).entries.keys()]),
  );
  const { usages, scanned } = scanProject(root);
  const findings = [];
  const skip = (name) => BUILTINS.has(name) || isIgnored(name);

  for (const [name, places] of [...usages].sort(([a], [b]) => a.localeCompare(b))) {
    if (skip(name) || example.entries.has(name)) continue;
    findings.push({
      rule: 'undocumented', severity: 'error', name, ...places[0], occurrences: places.length,
      message: `used in code but missing from ${exampleFile ?? 'the example file'}`,
    });
  }

  for (const [name, { value, line }] of example.entries) {
    const reason = detectSecret(name, value);
    if (reason && !isIgnored(name)) {
      findings.push({
        rule: 'secret', severity: 'error', name, file: exampleFile, line,
        message: `looks like a real secret (${reason}): rotate it and use a placeholder`,
      });
    }
    if (!usages.has(name) && !skip(name)) {
      findings.push({
        rule: 'unused', severity: 'warning', name, file: exampleFile, line,
        message: 'documented but never read in code',
      });
    }
    if (presentEnvFiles.length > 0 && !localNames.has(name) && !skip(name)) {
      findings.push({
        rule: 'missing-local', severity: 'warning', name, file: presentEnvFiles[0],
        message: `declared in ${exampleFile} but not set locally`,
      });
    }
  }

  for (const { name, line } of example.duplicates) {
    findings.push({
      rule: 'duplicate', severity: 'warning', name, file: exampleFile, line,
      message: 'declared more than once',
    });
  }

  for (const file of presentEnvFiles) {
    const message = checkGitExposure(root, file);
    if (message) findings.push({ rule: 'exposed-env', severity: 'error', file, message });
  }

  return {
    findings,
    exampleFile,
    stats: { scanned, inCode: usages.size, inExample: example.entries.size },
  };
}

/** Appends every undocumented variable to the example file and returns their names. */
export function fixUndocumented(root, result) {
  const names = result.findings.filter((f) => f.rule === 'undocumented').map((f) => f.name);
  if (names.length === 0) return [];
  const file = join(root, result.exampleFile ?? EXAMPLE_CANDIDATES[0]);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current && !current.endsWith('\n') ? eol : '';
  writeFileSync(file, current + separator + names.map((name) => `${name}=${eol}`).join(''));
  return names;
}
