# Nidavellir plugin development

Nidavellir currently supports local JavaScript plugins loaded from the application's `plugins/` directory. See the bundled example plugins for the manifest and entry-point shape.

## Principles

- Plugins are executable code. A manifest is metadata, not a sandbox.
- Install only plugins you trust. Review source code before enabling a third-party plugin.
- Do not put API keys or other secrets in plugin files, manifests, logs, or source control.
- Plugins should request the narrowest capability they need and explain why.
- Do not assume a plugin can use a provider unless the user configured credentials and the provider's API permits the requested use.
- Keep destructive actions, file writes, command execution, and network operations behind explicit user consent.

## Multi-provider AI collaboration

The built-in AI workflow supports OpenAI, Gemini, and Claude adapters when valid API keys are configured. This does not automatically grant access to every model, account, IDE extension, or paid service. Each provider has its own models, quotas, billing, API terms, and authentication.

For collaborative tasks, the intended flow is:
1. Gather bounded, user-approved project context.
2. Ask each enabled provider independently and retain its raw response.
3. Show provider failures rather than silently pretending every agent responded.
4. Ask the coordinator to synthesize responses and identify disagreements.
5. Present code changes as a diff for review.
6. Run tests only after user confirmation and report the actual result.

## Before publishing a plugin

- Validate its manifest and inputs.
- Test with missing keys, network failures, malformed responses, and large inputs.
- Avoid sending workspace contents externally unless the user has explicitly selected that workflow.
- Document permissions, external services, data transmitted, and any expected costs.
- Never claim isolation unless the implementation actually enforces it.
