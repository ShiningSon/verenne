# Security policy

## Supported releases

Security fixes are provided for the latest 1.x release. Upgrade before reporting a defect that is already fixed in a newer release.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's [private vulnerability reporting form](https://github.com/ShiningSon/verenne/security/advisories/new). Include the affected Verenne version, operating system, provider CLI and version, reproduction steps, impact, and any proposed mitigation. Remove API keys, repository secrets, prompts, and private source code from the report. Maintainers aim to acknowledge a complete report within five business days.

## Execution boundary

Verenne runs third-party coding-agent CLIs and base-owned repository commands. Git worktrees isolate candidate changes from one another; they are not an operating-system sandbox. Agents and trusted bootstrap commands can execute with the current user's privileges. Base policy is therefore executable trust, not passive configuration. Run untrusted repositories inside a disposable container or isolated CI worker with minimal filesystem, network, and provider permissions.

Verenne applies several narrower boundaries inside that host:

- provider processes receive adapter-specific environment allowlists rather than the entire host environment;
- policy and gate definitions are loaded from the trusted base commit;
- candidate verification bootstrap uses a temporary home without host registry tokens or proxy settings;
- replay gates use an isolated home and a minimal environment;
- changes to tests, runners, manifests, lockfiles, and other verification inputs trigger a second base-restored replay suite;
- executable paths, patch digests, parent Git state, result contracts, evidence paths, and symlink boundaries are checked fail-closed;
- `SIGINT` and `SIGTERM` propagate to active provider, bootstrap, and gate process trees before the CLI returns.

These controls reduce accidental credential exposure and false-green results. They do not prevent a malicious process from exploiting the host kernel, accessing resources already available through its OS identity, or using network access allowed by the runner.

## Credentials and private dependencies

Authentication remains owned by each provider CLI. Verenne does not copy credentials between providers or ask for a separate Verenne account. The initial trusted lane bootstrap can use explicitly allowed host package credentials. Candidate replay deliberately cannot. A private-registry project can therefore fail closed during replay unless dependencies are available inside the isolated execution environment; validate that setup before relying on Verenne in CI.

Never commit credentials to `verenne.policy.json`, gate environment fields, claim files, or adapter arguments. Prefer provider login stores, short-lived CI credentials, and an isolated runner.

## Dashboard and artifacts

The dashboard binds to loopback by default and rejects cross-origin mutation requests. Do not expose it remotely without an authenticated reverse proxy and transport security.

Generated share-safe reports redact known credential fields, prompt content, environment values, and absolute paths. Redaction is defense in depth, not a guarantee for arbitrary secrets embedded in source or provider output. Inspect an artifact before publishing it. Raw mission state, lane logs, prompts, patches, and provider output under `.verenne/` are not share-safe and can contain repository details.

Verenne does not add product telemetry. Network access is determined by the selected agent CLI, dependency tools, and commands in the repository's trusted verification policy.
