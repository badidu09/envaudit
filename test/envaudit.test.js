import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { audit, fixUndocumented } from '../src/audit.js';
import { main } from '../src/cli.js';
import { parseDotenv } from '../src/dotenv.js';
import { findVariables, scanProject } from '../src/scan.js';
import { detectSecret } from '../src/secrets.js';

const created = [];
after(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files, { git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'envaudit-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (git) spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

const rules = (result, rule) => result.findings.filter((f) => f.rule === rule).map((f) => f.name);
const names = (file, text) => findVariables(file, text).map((f) => f.name).sort();

test('parses comments, export, quotes, inline comments and multi-line values', () => {
  const { entries, duplicates } = parseDotenv(
    [
      '# comment', '', 'A=1', 'export B=two # trailing', 'C="quoted # kept"', "D='single'",
      'E="line1', 'line2"', 'F=after', 'A=again', 'not a line',
    ].join('\r\n'),
  );
  assert.deepEqual([...entries.keys()], ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(entries.get('B').value, 'two');
  assert.equal(entries.get('C').value, 'quoted # kept');
  assert.equal(entries.get('E').value, 'line1\nline2');
  assert.equal(entries.get('F').line, 9);
  assert.deepEqual(duplicates, [{ name: 'A', line: 10 }]);
});

test('an unterminated quote does not swallow later keys', () => {
  const { entries } = parseDotenv('A="oops\nB=2\n');
  assert.equal(entries.get('B').value, '2');
});

test('finds JavaScript and TypeScript reads in every common form', () => {
  const source = `
    process.env.DOT; process.env['BRACKET']; process.env?.OPTIONAL;
    import.meta.env.VITE_URL; Bun.env.BUN_VAR; Deno.env.get("DENO_VAR");
    const { ONE, TWO: renamed, THREE = 'x', ...rest } = process.env;
  `;
  assert.deepEqual(names('a.ts', source), [
    'BRACKET', 'BUN_VAR', 'DENO_VAR', 'DOT', 'ONE', 'OPTIONAL', 'THREE', 'TWO', 'VITE_URL',
  ]);
});

test('ignores dynamic access', () => {
  assert.deepEqual(names('a.js', 'process.env[key]; const { a } = other;'), []);
});

test('finds reads in other languages', () => {
  assert.deepEqual(names('a.py', 'os.environ["A"]; os.environ.get("B"); os.getenv(\'C\')'), ['A', 'B', 'C']);
  assert.deepEqual(names('a.go', 'os.Getenv("A"); os.LookupEnv("B")'), ['A', 'B']);
  assert.deepEqual(names('a.rs', 'env::var("A"); env!("B"); option_env!("C")'), ['A', 'B', 'C']);
  assert.deepEqual(names('a.rb', 'ENV["A"]; ENV.fetch("B")'), ['A', 'B']);
  assert.deepEqual(names('a.php', "getenv('A'); env('B'); $_ENV['C'];"), ['A', 'B', 'C']);
  assert.deepEqual(names('A.java', 'System.getenv("A")'), ['A']);
  assert.deepEqual(names('a.cs', 'Environment.GetEnvironmentVariable("A")'), ['A']);
  assert.deepEqual(names('compose.yaml', 'a: ${A}\nb: ${B:-x}'), ['A', 'B']);
});

test('reports line numbers and skips dependencies and hidden folders', () => {
  const root = project({
    'src/a.js': '\n\nprocess.env.A',
    'node_modules/x/i.js': 'process.env.DEP',
    '.next/i.js': 'process.env.BUILD',
  });
  const { usages } = scanProject(root);
  assert.deepEqual([...usages.keys()], ['A']);
  assert.deepEqual(usages.get('A'), [{ file: 'src/a.js', line: 3 }]);
});

test('honours .gitignore inside a git repository', () => {
  const root = project({ '.gitignore': 'gen/\n', 'gen/a.js': 'process.env.GEN', 'a.js': 'process.env.A' }, { git: true });
  assert.deepEqual([...scanProject(root).usages.keys()], ['A']);
});

test('flags real-looking secrets without flagging placeholders', () => {
  // Assembled at runtime so that secret scanners don't flag this file.
  const stripe = 'sk_li' + 've_' + 'a1B2c3D4e5F6g7H8i9J0';
  const github = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0a1B2c3D4e5F6g7H8';
  assert.ok(detectSecret('STRIPE', stripe));
  assert.ok(detectSecret('ANY', github));
  assert.ok(detectSecret('API_KEY', 'q8Zr2LpX0vTn5KwY7mB'));
  assert.ok(detectSecret('DB', 'postgres://admin:S3cr3tVal@prod.acme.io/app'));

  for (const [name, value] of [
    ['API_KEY', ''], ['API_KEY', 'your_api_key_here'], ['API_KEY', 'changeme'], ['API_KEY', '<token>'],
    ['STRIPE', 'sk_live_xxxxxxxxxxxxxxxxxxxx'], ['NEXTAUTH_SECRET', 'generate-with-openssl-rand'],
    ['DB', 'postgres://postgres:postgres@localhost:5432/app'], ['DB', 'postgres://u:hunter2@db:5432/app'],
    ['DB', 'postgres://user:password@prod.acme.io/app'], ['TOKEN_URL', 'https://auth.acme.io/oauth/token'],
    ['COLOR', 'q8Zr2LpX0vTn5KwY7mB'],
  ]) {
    assert.equal(detectSecret(name, value), null, `${name}=${value}`);
  }
});

test('audit reports each kind of drift', () => {
  const root = project({
    'a.js': 'process.env.USED; process.env.NEW; process.env.NEW; process.env.NODE_ENV',
    '.env.example': 'USED=\nDEAD=\nDEAD=\n',
    '.env': 'USED=1\n',
  });
  const result = audit(root);
  assert.deepEqual(rules(result, 'undocumented'), ['NEW']);
  assert.equal(result.findings.find((f) => f.name === 'NEW').occurrences, 2);
  assert.deepEqual(rules(result, 'unused'), ['DEAD']);
  assert.deepEqual(rules(result, 'missing-local'), ['DEAD']);
  assert.deepEqual(rules(result, 'duplicate'), ['DEAD']);
});

test('reads .env.local alongside .env, and skips local checks without any local file', () => {
  const files = { 'a.js': 'process.env.A; process.env.B', '.env.example': 'A=\nB=\n' };
  assert.deepEqual(rules(audit(project(files)), 'missing-local'), []);
  const root = project({ ...files, '.env': 'A=1\n', '.env.local': 'B=2\n' });
  assert.deepEqual(rules(audit(root), 'missing-local'), []);
});

test('ignore patterns support exact names and prefixes', () => {
  const root = project({ 'a.js': 'process.env.VERCEL_URL; process.env.DEBUG; process.env.KEEP', '.env.example': '' });
  assert.deepEqual(rules(audit(root, { ignore: ['VERCEL_*', 'DEBUG'] }), 'undocumented'), ['KEEP']);
});

test('detects .env files that are tracked or not ignored', () => {
  const notIgnored = project({ '.env': 'A=1\n' }, { git: true });
  assert.match(audit(notIgnored).findings.find((f) => f.rule === 'exposed-env').message, /not in \.gitignore/);

  spawnSync('git', ['add', '.env'], { cwd: notIgnored });
  assert.match(audit(notIgnored).findings.find((f) => f.rule === 'exposed-env').message, /tracked/);

  const ignored = project({ '.gitignore': '.env\n', '.env': 'A=1\n' }, { git: true });
  assert.deepEqual(audit(ignored).findings.filter((f) => f.rule === 'exposed-env'), []);
});

test('fix appends to the example file, keeps line endings and is idempotent', () => {
  const root = project({ 'a.js': 'process.env.NEW', '.env.example': 'OLD=1\r\nLAST=2' });
  assert.deepEqual(fixUndocumented(root, audit(root)), ['NEW']);
  assert.equal(readFileSync(join(root, '.env.example'), 'utf8'), 'OLD=1\r\nLAST=2\r\nNEW=\r\n');
  assert.deepEqual(fixUndocumented(root, audit(root)), []);
});

test('fix creates the example file when there is none', () => {
  const root = project({ 'a.js': 'process.env.NEW' });
  fixUndocumented(root, audit(root));
  assert.equal(readFileSync(join(root, '.env.example'), 'utf8'), 'NEW=\n');
});

function run(args) {
  let out = '';
  let err = '';
  const code = main(args, {
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
  });
  return { code, out, err };
}

test('CLI exit codes follow severity and --strict', () => {
  const clean = project({ 'a.js': 'process.env.A', '.env.example': 'A=\n' });
  assert.equal(run([clean]).code, 0);

  const warning = project({ '.env.example': 'DEAD=\n' });
  assert.equal(run([warning]).code, 0);
  assert.equal(run([warning, '--strict']).code, 1);

  assert.equal(run([project({ 'a.js': 'process.env.A', '.env.example': '' })]).code, 1);
});

test('CLI rejects invalid usage with exit code 2', () => {
  assert.equal(run(['--nope']).code, 2);
  assert.equal(run(['/does/not/exist']).code, 2);
  assert.equal(run([project({}), '--example', 'missing']).code, 2);
});

test('JSON output never contains secret values', () => {
  const secret = 'q8Zr2LpX0vTn5KwY7mB';
  const root = project({ 'a.js': 'process.env.API_KEY', '.env.example': `API_KEY=${secret}\n` });
  const { code, out } = run([root, '--json']);
  assert.equal(code, 1);
  assert.equal(out.includes(secret), false);
  assert.equal(JSON.parse(out).findings[0].rule, 'secret');
});
