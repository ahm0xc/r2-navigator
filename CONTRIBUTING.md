# Contributing to r2n

Thanks for contributing to `@ahm0xc/r2-navigator` (`r2n`).

## Prerequisites

- [Bun](https://bun.sh) >= 1.x (package manager + builder)
- Node >= 18 (the published binary targets Node)
- A Cloudflare R2 test account for live verification (never commit real tokens)

## Setup

```sh
bun install
bun run dev -- --help   # run CLI from source
```

## Scripts

| Command             | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `bun run dev`       | Run `src/cli.ts` from source                              |
| `bun run typecheck` | `tsc --noEmit` — must pass before opening a PR            |
| `bun run build`     | `bun build src/cli.ts --outfile dist/cli.js --target node --packages external` |

`dist/` is gitignored build output; never commit it.

## Project layout

```
src/
  cli.ts            # bin entry (commander router)
  commands/auth.ts  # r2n auth flow (@clack/prompts)
  lib/config.ts     # file-only credential store (~/.config/r2n, 0600)
  lib/r2.ts         # S3-compatible R2 client wrappers
  ui/App.tsx        # Ink navigator TUI
```

Conventions:

- Single profile, file-only credential storage — don't add keychain/env-file alternatives without discussion (see README).
- R2 access goes through `src/lib/r2.ts` so auth, validation, and the TUI share one client factory.
- TUI changes stay in `src/ui/` (Ink + React). Keep keybindings in sync with the footer guide and README table.

## Testing

- `bun run typecheck` must pass.
- `bun run build`, then smoke-test the binary with both runtimes:
  ```sh
  ./dist/cli.js --help
  node ./dist/cli.js auth --status
  ```
- Live checks (`r2n auth` + `r2n` browsing/upload/delete) need real R2 credentials — use a disposable test bucket, and verify `auth --status` masks the secret.

## Pull requests

1. Fork, branch from `main` (`feat/<name>`, `fix/<name>`).
2. Keep PRs focused; update README/CONTRIBUTING if you change UX, keys, or storage.
3. Ensure typecheck + build + smoke test pass; describe manual live-test results in the PR.
4. Don't commit credentials, `dist/`, or `node_modules/`.

## Publishing (maintainers)

```sh
bun run build
npm publish --access public
```
