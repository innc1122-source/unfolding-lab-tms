# Contributing

Use Node.js 24+. Keep pull requests focused and describe the behavior changed and checks run.

1. Create a feature branch.
2. Install pinned frontend dependencies with `npm --prefix web ci` when editing the frontend.
3. Run `npm run build:web` for frontend edits and include updated `public/dist/` files, since the demo deployment serves these files directly.
4. Run relevant tests; use `npm test` for a full regression run. Test helpers use temporary databases; never point test scripts at real data.
5. Keep Chinese and English interface text consistent.
6. Do not commit passwords, tokens, real employee data, runtime databases or uploaded customer files.

Contributions are submitted under the project's Apache-2.0 license. Only contribute work you have the right to share. Security reports should use the private reporting contact in SECURITY.md rather than a public issue.
