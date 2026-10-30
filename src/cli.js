import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { audit, DEFAULT_ENV_FILES, fixUndocumented } from './audit.js';

const HELP = `envaudit - keep your code, .env.example and .env in sync

Usage: envaudit [directory] [options]

Options:
  --example <file>   Example file (default: auto-detects .env.example, .env.sample,
                     .env.template, .env.dist)
  --env <file>       Local env file, repeatable (default: ${DEFAULT_ENV_FILES.join(', ')})
  --ignore <names>   Comma-separated names to skip, "*" suffix allowed (e.g. VERCEL_*,DEBUG)
  --fix              Append undocumented variables to the example file
  --strict           Exit with code 1 on warnings too
  --json             Print machine-readable JSON
  -v, --version      Print the version
  -h, --help         Print this help

Exit codes: 0 clean, 1 problems found, 2 invalid usage
`;

function paint(enabled) {
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { red: wrap(31), yellow: wrap(33), green: wrap(32), dim: wrap(2), bold: wrap(1) };
}

function describeLocation({ file, line, occurrences }) {
  if (!file) return '';
  const extra = occurrences > 1 ? ` (+${occurrences - 1} more)` : '';
  return `${file}${line ? `:${line}` : ''}${extra}`;
}

function printReport({ findings, exampleFile, stats }, write, color) {
  write(
    color.dim(
      `Scanned ${stats.scanned} files: ${stats.inCode} variables in code, ` +
        `${stats.inExample} in ${exampleFile ?? '(no example file)'}\n`,
    ),
  );
  for (const finding of findings) {
    const icon = finding.severity === 'error' ? color.red('✖') : color.yellow('⚠');
    const subject = finding.name ? `${color.bold(finding.name)} ` : '';
    const location = describeLocation(finding);
    write(
      `${icon} ${color.dim(finding.rule.padEnd(13))} ${subject}${finding.message}` +
        `${location ? color.dim(`  ${location}`) : ''}\n`,
    );
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  write(
    findings.length === 0
      ? color.green('✔ Everything is in sync\n')
      : `\n${errors} error(s), ${warnings} warning(s)\n`,
  );
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        example: { type: 'string' },
        env: { type: 'string', multiple: true },
        ignore: { type: 'string', multiple: true },
        fix: { type: 'boolean' },
        strict: { type: 'boolean' },
        json: { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    stderr.write(`${error.message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.help) {
    stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (positionals.length > 1) {
    stderr.write('Expected at most one directory\n');
    return 2;
  }

  const root = resolve(positionals[0] ?? '.');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    stderr.write(`Not a directory: ${root}\n`);
    return 2;
  }
  if (values.example && !existsSync(resolve(root, values.example))) {
    stderr.write(`Example file not found: ${values.example}\n`);
    return 2;
  }

  const options = {
    example: values.example,
    envFiles: values.env,
    ignore: (values.ignore ?? []).flatMap((value) => value.split(',')).map((s) => s.trim()).filter(Boolean),
  };
  let result = audit(root, options);
  const fixed = values.fix ? fixUndocumented(root, result) : [];
  if (fixed.length > 0) result = audit(root, options);

  const failed = result.findings.some((f) => f.severity === 'error' || values.strict);

  if (values.json) {
    stdout.write(`${JSON.stringify({ ok: !failed, fixed, ...result }, null, 2)}\n`);
  } else {
    const color = paint(Boolean(stdout.isTTY) && !process.env.NO_COLOR);
    if (fixed.length > 0) {
      stdout.write(color.green(`Added ${fixed.length} variable(s) to the example file: ${fixed.join(', ')}\n`));
    }
    printReport(result, (text) => stdout.write(text), color);
  }
  return failed ? 1 : 0;
}
