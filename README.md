# r2n — R2 Navigator

Interactive terminal navigator for Cloudflare R2 buckets. Published as `@ahm0xc/r2-navigator`, binary `r2n`.

## Install

```sh
npm i -g @ahm0xc/r2-navigator
```

## Usage

```sh
r2n auth          # onboard: enter Account ID + API token, verified via ListBuckets
r2n auth --status # show what's stored (secret masked)
r2n auth --reset  # or: r2n logout
r2n               # browse buckets
```

`r2n auth` walks you through creating a token at
`dash.cloudflare.com > R2 > Manage R2 API tokens`, then tests the credentials
before saving. On success it prints `Run 'r2n' to browse`.

## Navigator keys

| Key | Action |
| --- | ------ |
| `↑`/`↓` (`j`/`k`) | Move (large lists render 100 rows at a time — `↓` extends, `PgDn`/`PgUp` jump) |
| `→`/`Enter` (`l`) | Enter bucket / folder |
| `←` (`h`/`Esc`) | Go back |
| `Space` / `a` | Toggle one / all checkboxes |
| `Backspace` twice | Delete selected (or cursor item); first press arms, `Esc` cancels |
| `u` | Upload a file — or a folder (recreated here with all its files); runs in the background with progress in the status footer |
| `n` | Create folder |
| `o` | Download selected files to cwd; folders (or mixed selections) are zipped into `<folder>.zip` / `r2n-selection.zip` |
| `r` | Refresh |
| `q` | Quit |

Folders delete recursively (all keys under the prefix). Bucket deletion is not
supported in v1 — use the dashboard.

## Credentials

File-only, single profile (per your choice):

- Stored at `$XDG_CONFIG_HOME/r2n/credentials.json` (default `~/.config/r2n/credentials.json`), dir `0700`, file `0600`.
- Env vars override the file (useful for CI): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, optional `R2_ENDPOINT` (`R2N_*` aliases also work).

## Develop

```sh
bun install
bun run dev -- --help   # run CLI from source
bun run typecheck
bun run build           # bun build src/cli.ts --outfile dist/cli.js --target node --packages external
```

## Publish

```sh
bun run build
npm publish --access public
```
