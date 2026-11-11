# Initial open-source release checks

Checked 2026-11-10, using Node.js 24.21.0.

## Included changes

- Apache-2.0 license, project notice, bilingual README, contribution and security-reporting instructions.
- Locked dependency tree and collected third-party license files.
- Updated Tiptap to 3.33.1, React Router DOM to 7.18.5, Vite to 6.4.6, plugin-react to 4.7.0 and SheetJS to the official 0.20.3 distribution; rebuilt `public/dist/`.
- Kept the original demo deployment files; added a separately named persistent-production Dockerfile and Compose example.
- Exported a source snapshot without private Git history, runtime configuration, databases, attachments, backups or logs. Omitted internal historical baseline/handover snapshots from the public release.

## Verification

- 62 selected authentication, security, configuration, module and branding tests: passed, no failures or skips.
- Frontend production build: passed. Existing large-chunk warnings remain.
- `npm --prefix web audit`: zero reported vulnerabilities in the locked tree at check time. This is a registry advisory check, not a guarantee of absence of vulnerabilities.
- Browser smoke: local synthetic-data demo starts; employee login, home dashboard, program route and Chinese/English switching pass.
- Basic release text scan found only the intentionally public test TLS private-key fixtures. These are documented under `test/fixtures/ai-tls/README.md`; not production credentials. No runtime config.json or database was included.

## Not claimed

The full historical regression suite was not run for this release. A separate security assessment, load test and production Docker build were not performed. Docker was unavailable in the release preparation environment; validate `Dockerfile.production` on a Docker-capable host before production use. LibreOffice/media conversion flows were not verified in this environment. This release does not establish a support SLA, hosted subscription, multi-tenant SaaS capability or production certification.

The optional CI workflow template is `docs/ci-example.yml`; no automated workflow is enabled in the initial public repository. It can be installed later with an account permitted to edit GitHub Actions workflows.
