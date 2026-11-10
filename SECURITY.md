# Security

Report suspected vulnerabilities privately to **hi@unfolding-lab.com**. Include the affected commit, steps to reproduce and expected impact. Do not attach real employee records, access tokens or passwords. No response-time guarantee or bug bounty is currently offered.

- Use `production: true` for persistent real instances. The demo launcher and original Dockerfile intentionally reset synthetic data.
- Protect internet-facing deployments with HTTPS, access controls and regular backups. Confirm permissions with your own organization before importing real data.
- AI is optional. Review the configured provider and permitted data fields before enabling external requests.
- `test/fixtures/ai-tls/` contains **test-only** certificate/private-key pairs used by local fake-provider tests; they are not deployment credentials and must not be reused.
- Dependency results and release verification are documented in `docs/RELEASE-CHECKS.md`. A passed test suite is not an independent security assessment.
