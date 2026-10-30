# envaudit

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Keep your code, `.env.example` and `.env` in sync, and catch secrets before they leak.**

"It works on my machine" is often a variable someone added to `.env` and never documented. `envaudit` reads your source code, compares it with your env files, and tells you what drifted. It has zero dependencies, needs no configuration, and never prints the values of your variables.

```console
$ npx github:badidu09/envaudit
Scanned 48 files: 12 variables in code, 11 in .env.example
✖ undocumented  STRIPE_WEBHOOK_SECRET used in code but missing from .env.example  src/pay.ts:14 (+1 more)
✖ secret        OPENAI_API_KEY looks like a real secret (AI provider API key): rotate it and use a placeholder  .env.example:7
✖ exposed-env   .env is not in .gitignore and could be committed by accident  .env
⚠ unused        LEGACY_API_URL documented but never read in code  .env.example:3
⚠ missing-local REDIS_URL declared in .env.example but not set locally  .env

3 error(s), 2 warning(s)
```

## What it checks

| Rule | Severity | Meaning |
| --- | --- | --- |
| `undocumented` | error | Read in code, missing from the example file |
| `secret` | error | The example file holds something that looks like a real credential |
| `exposed-env` | error | A local env file is tracked by git or not ignored |
| `unused` | warning | In the example file, never read in code |
| `missing-local` | warning | In the example file, not set in your local env files |
| `duplicate` | warning | Declared twice in the example file |

**Languages:** JavaScript, TypeScript, Vue, Svelte, Astro (Node, Vite, Bun, Deno), Python, Go, Rust, Ruby, PHP, Java, Kotlin, C#, and `docker-compose` files.

**Secret formats:** Stripe, AI provider API keys, GitHub, GitLab, Slack, AWS, Google, SendGrid, npm, webhook secrets, private keys, JWTs, URLs with embedded passwords, and high-entropy values in sensitive variables. Placeholders such as `your_key_here` and local URLs such as `postgres://postgres:postgres@localhost` are not flagged.

## Usage

Requires Node.js 20 or later. Run it from your project without installing anything:

```sh
npx github:badidu09/envaudit
```

Or install it globally:

```sh
npm install -g github:badidu09/envaudit
envaudit ./my-project
```

| Option | Description |
| --- | --- |
| `--example <file>` | Example file. Auto-detects `.env.example`, `.env.sample`, `.env.template`, `.env.dist` |
| `--env <file>` | Local env file, repeatable. Defaults to `.env` and `.env.local` |
| `--ignore <names>` | Comma-separated names to skip, with `*` as a suffix: `VERCEL_*,DEBUG` |
| `--fix` | Append undocumented variables to the example file, creating it if needed |
| `--strict` | Exit with code 1 on warnings too |
| `--json` | Print machine-readable JSON |

Exit codes: `0` clean, `1` problems found, `2` invalid usage.

## Use it in CI

```yaml
# .github/workflows/env.yml
name: Env audit
on: [push, pull_request]
jobs:
  envaudit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: badidu09/envaudit@v1
        with:
          args: --ignore VERCEL_*
```

The action accepts `path` (default `.`) and `args`. `.env` is normally absent in CI, so the local checks are skipped there.

## Limitations

`envaudit` matches source text rather than executing it, so:

- Dynamic reads such as `process.env[name]` are not detected. Declare those names in the example file and add them to `--ignore` if they get reported as `unused`.
- Reads inside comments count as usage.
- Variables read by your libraries rather than your code, such as Prisma's `DATABASE_URL`, are reported as `unused`. Add them to `--ignore`.
- Secret detection is a safety net based on patterns. It doesn't replace a dedicated scanner on your full git history.

## Contributing

Issues and pull requests are welcome, especially new languages and secret formats. Language rules live in [`src/scan.js`](src/scan.js) and secret formats in [`src/secrets.js`](src/secrets.js). Run the tests with `npm test`.

## License

[MIT](LICENSE)
