# Shared design files: don't edit here

These files are copies from the yunshu.ai site repository, which is the source of truth, so the
demo looks like the main site:

- `src/styles/tokens.css`, `src/styles/fonts.css`, `src/styles/global.css`
- `src/lib/logo-geometry.mjs`, `src/components/Logo.astro`
- `public/favicon.svg`

To change them, edit them in yunshu.ai, run `npm run design:sync` there (it copies them into a
sibling `../agent-wallet` checkout), then commit and push this repo. yunshu.ai's CI runs
`npm run design:check` and fails if these copies drift.

Dashboard-specific styles belong in the components' own `<style>` blocks.
