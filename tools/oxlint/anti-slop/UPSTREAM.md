# Vendored anti-slop Oxlint plugin

Copied from crumble-project/bot at commit `ad25420` (`tools/oxlint/anti-slop/`), without `effect/`.

Source: `install-anti-slop` skill assets (`agents/.agents/skills/install-anti-slop/assets/anti-slop/`) in [cheetahbyte/dotfiles](https://github.com/cheetahbyte/dotfiles), installed 2026-10-18.

Source revision: dotfiles `HEAD` was `cffc8b4a0f9a19a61a738ad560d91b50a8f19902` (assets last committed in `31b21289d9c6f86a279fe74f23c2fe1614690f0a`), but the working tree had uncommitted changes to:

- `rules/require-readable-spacing.ts`
- `vendor/eslint-stylistic/UPSTREAM.md`
- `vendor/eslint-stylistic/padding-line-between-statements.ts`

No commit identifies the copied assets exactly. The pristine copy is identified by this tree checksum, computed from the asset directory with `find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256`:

```
24f771967ed0c6595fcac4adb93086b4996ccb06a570146f059e720bbf807acf
```

This file is not part of the checksum.

## Installed paths

- `tools/oxlint/anti-slop/index.ts` (registered as `anti-slop` in `.oxlintrc.json`)
- `tools/oxlint/anti-slop/effect/` (copied but not registered; the repository has no direct `effect` dependency)
- `tools/oxlint/anti-slop/vendor/eslint-stylistic/` (license and provenance in that directory)

## Local deviations

- `shared/dictionary-types.ts`: `unsafeMembers[0]` becomes `(unsafeMembers[0] ?? null)` so the file typechecks under this repository's `noUncheckedIndexedAccess`. The preceding `length > 0` guard means behaviour is unchanged.
