# Nidavellir

Nidavellir is an independent Electron desktop coding environment with a Monaco editor, project runner, plugin hooks, and an AI workbench for configured providers. It is not a clone of Visual Studio Code; see the roadmap for planned gaps.

## Install once, update automatically

1. Download the Windows installer from GitHub Releases and install Nidavellir once.
2. Installed builds check for updates at launch and every four hours. Available updates download in the background and Nidavellir asks you to restart to finish installation. A staged update also installs when you quit.
3. Use Help > Check for Updates or click the update status in the bottom bar. Automatic updates can be disabled in Settings.

After the first install, normal future releases should not require manual installer downloads. This requires internet access and a published GitHub Release. The repository must remain public for updater access without a token.

### Platform notes

- Windows: per-user NSIS installer supports automatic updates. The unsigned first install may trigger a Windows SmartScreen warning.
- Linux: AppImage supports electron-updater. Keep the AppImage in a writable location and install the AppImage/FUSE runtime requirements.
- macOS: automatic updates require a code-signed and notarized app. Unsigned builds must be replaced manually.

## Run from source

Requires Node.js 22 or newer and npm.

```sh
npm install
npm start
npm test
```

`npm install` copies Monaco into `src/vendor/monaco`, allowing packaged builds to load the editor locally instead of relying on a CDN. User plugins are kept in Electron's persistent user-data directory, outside the installed application files.

## Build locally

```sh
npm run dist:win
npm run dist:linux
npm run dist:mac
```

Build artifacts are written to `dist/`. These local commands build installers but do not publish updates.

## Publish an update

Merge reviewed changes into `main`, then from a clean checkout of `main`, run:

```sh
npm run release
```

The first merge of version 0.4.3 into `main` automatically creates the matching `v0.4.0` tag and publishes a GitHub Release with update metadata. For subsequent releases, from a clean checkout of `main`, run `npm run release`; it runs tests, increments the patch version, and pushes the commit and tag. The tag workflow then publishes Windows and Linux packages and their updater metadata. Installed copies use this metadata to fetch future updates. Wait for tests/builds to pass before considering a release ready.

## Features and limitations

- Electron desktop interface with Monaco, file open/save, project explorer, and plain-text fallback.
- Project runner supports common language runtimes when installed. Timeouts and output caps are safeguards, not an OS sandbox.
- OpenAI, Gemini, and Claude integrations require your own API keys; API use may cost money.
- Plugins execute with your account's OS permissions. Enable only plugins whose source you trust.
- This branch does not include every feature described in the separate v0.3 upgrade report; the full report's referenced source ZIP was not included in this merge.

## Security

- API keys are encrypted through Electron `safeStorage` where supported.
- The renderer is isolated from Node APIs and uses a content security policy.
- Do not run untrusted code or install untrusted plugins.

## Roadmap

Integrated terminal experience (xterm.js/node-pty), debugger (DAP), language servers, extension compatibility, split editors, and multi-root workspaces.


## Free local AI with Ollama

Nidavellir can use a local Ollama model without an API key. Install Ollama from https://ollama.com, then download a coding model in a terminal:

```sh
ollama pull qwen2.5-coder:7b
```

Start Ollama, open Nidavellir, enable **Local Ollama (no API key)** in the AI workbench, and ask the team. The default local endpoint is `http://127.0.0.1:11434` and the default model is `qwen2.5-coder:7b`. You can override the model for development with `NIDAVELLIR_OLLAMA_MODEL`; the endpoint stays fixed to loopback for security. Local model quality and speed depend on available RAM/CPU/GPU. Run `npm test` to exercise provider behavior without installing Ollama.
