# Contributing

Thanks for improving Verenne Code. Keep each change focused on an observable user outcome, add regression coverage, and explain how the outcome can be independently verified.

## Local checks

Requirements are Node.js 20+ and Git.

```bash
npm ci
npm run check
npm pack --dry-run --json
```

The runtime intentionally has zero third-party dependencies. A dependency proposal should include a measured reason, security and portability impact, and why the capability cannot remain in the standard library. Changes must remain portable across Windows, macOS, and Linux.

## Pull requests

A pull request should identify:

1. the requested user-visible outcome;
2. the changed paths that deliver it;
3. the required claim IDs and kinds;
4. the base-owned gate or deterministic evidence that proves each claim;
5. any provider CLI, Node.js, Git, or operating-system compatibility impact.

Verification and selection changes must remain fail-closed. Add adversarial coverage for false-green tests, policy or runner tampering, malformed result contracts, path escapes, credential leakage, and process cancellation when relevant. Share-safe artifacts must not expose prompts, secrets, environment values, or absolute local paths.

Do not combine behavior changes with a model-ID refresh unless they are inseparable. Provider-native IDs are passed through verbatim; tests should use fixtures rather than requiring paid provider access.

For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Release process

`verenne` is published from `.github/workflows/release.yml` on a published GitHub Release. The release tag must exactly match `v<package.json version>`.

The npm package should configure this Trusted Publisher:

- provider: GitHub Actions;
- owner: `ShiningSon`;
- repository: `verenne`;
- workflow: `release.yml`;
- environment: `npm`;
- permission: publish.

The workflow uses a GitHub-hosted runner and `id-token: write`. npm exchanges that OIDC identity for a short-lived publishing credential and generates provenance automatically for the public package. Do not add `NODE_AUTH_TOKEN`, an npm automation token, or `--provenance` to this trusted-publishing path.

After the versioned release succeeds, point the floating `v1` Git tag at the same reviewed commit so the documented `ShiningSon/verenne@v1` Action reference remains valid. Never move `v1` before the versioned release and package smoke checks pass.

The first-ever publication is the bootstrap exception: if npm cannot attach a Trusted Publisher before the package exists, a maintainer may run `npm publish --access public` locally with interactive npm authentication and required 2FA. A local publish has no GitHub build provenance. Immediately configure the Trusted Publisher, restrict or revoke token publishing, and use the release workflow for every later version.
