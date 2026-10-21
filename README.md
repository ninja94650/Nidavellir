# Nidavellir

Nidavellir is an independent Electron desktop coding environment with a Monaco editor, local plugin hooks, a safe-runner workflow, and an AI workbench for configured providers.

> **Scope note:** Nidavellir is not yet feature-equivalent to Visual Studio Code. See [the parity roadmap](docs/VS_CODE_PARITY.md) for implemented foundations, planned work, security priorities, and completion criteria.

## Studio interface

The current Electron interface uses the Nidavellir Studio visual direction: a dark editor workspace, welcome banner, file explorer, AI workbench for configured providers, diff-review workflow, and terminal/output panel. The welcome actions connect to the existing New File and AI Workbench controls; the interface is styled in `src/styles.css` and the actual app remains wired to its Electron preload/backend APIs.

The separately supplied HTML/CSS/JavaScript mockup was used as a visual reference, not copied over the working Electron frontend, because its mock file contents and simulated AI/run actions would replace real project integrations with placeholders.

## Current features

- Electron desktop app with Monaco editor and a plain-text fallback.
- Open files and folders, browse a project tree, and save edits.
- Run supported project code from a temporary snapshot so Run does not overwrite the source file; includes source-size, timeout, output, and process-tree stop safeguards (not a security sandbox).
- Configure OpenAI, Google Gemini, and Anthropic Claude API keys; keys are stored using Electron `safeStorage` where available.
- Ask configured AI providers for help, synthesize responses, generate tests, and review proposed changes before applying them.
- Discover local JavaScript plugins from `plugins/`; they start disabled and require explicit confirmation before activation.
- Example plugins and Node.js smoke tests.

## Requirements

- Node.js (current LTS recommended)
- npm
- A supported desktop OS for Electron
- Optional: API keys for the AI providers you intend to use
- Optional: runtimes/compilers for the languages you want to execute

## Run from source

```bash
npm install
npm start
```

Run tests:

```bash
npm test
```

Create a local unpacked build:

```bash
npm run dist:dir
```

Build an installable desktop package for your operating system:

```bash
# Windows installer (.exe)
npm run dist:win

# Linux AppImage
npm run dist:linux

# macOS disk image (.dmg)
npm run dist:mac
```

On Windows, open PowerShell in the cloned repository folder and run `npm install`, then `npm start` to launch the app. To create an installer, run `npm run dist:win`; the installer is written to `dist/\`. The GitHub Actions workflow also builds a Windows installer and Linux AppImage, runs the existing test suite, and publishes the generated files as downloadable workflow artifacts when successful. A workflow must finish successfully before those artifacts are available.

The application is a desktop app; opening the repository in a browser does not run the Electron application. Monaco currently loads from a CDN, so an internet connection is needed for the full editor unless you vendor Monaco locally.

## AI providers and costs

Each provider must be configured by the user with its own valid API key and may require account access, billing, and an available model. Nidavellir does not grant access to every commercial AI model or third-party IDE extension automatically. Enable only providers you are authorized to use. AI calls may send the prompt and selected code to that provider; do not include secrets or files you do not intend to share.

## Plugin trust and security

Plugins are executable JavaScript and should be treated as trusted code. The current plugin API is intentionally small, but loading a plugin in the Electron main process is **not** a security sandbox. Install only reviewed plugins. See [plugin development and trust guidance](plugins/README.md).

Project execution also has risks. The runner passes a reduced environment, disables shell invocation, and bounds source size, runtime, and captured output, but project code still runs with your account's permissions and may access files or the network available to you. Use an OS sandbox or isolated VM for untrusted code. Temporary snapshots may not resolve relative imports exactly like the original file. Review code before running it and keep backups or use Git.

## Roadmap

The planned path toward a fuller development studio includes multi-tab editing, command palette and keybindings, workspace search, language-server support, debugging, Git UI, terminal/task integration, a more complete extension host, stronger IPC validation, and coordinated multi-agent workflows. These are goals, not claims that all are already implemented.

See [docs/VS_CODE_PARITY.md](docs/VS_CODE_PARITY.md).
