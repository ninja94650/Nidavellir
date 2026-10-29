# 0.4.17

- Releases the agentic Prompt Builder / Workbench update merged into main after successful unit tests, Linux package and UI checks, and Windows installer smoke test.
- Adds workspace-aware AI project building with permission-controlled context sharing, manifest-based proposed file changes, side-by-side diff review, and explicit approval before applying edits or running tests.
- Adds bounded test-and-repair workflows and improves AI Workbench quick-action and coworking-agent UI regression coverage.

- Removes the local Ollama provider while preserving configured API-key agents and multi-agent collaboration.
- Improves AI Workbench collapsible sections, chat sizing, scrolling, and regression coverage.
- Fixes brittle AI Workbench CSS assertions and keeps security/file-permission tests passing.

# 0.4.15

- Replaces the top-bar AI Settings button with an AI Workbench show/hide control; hosted API-key settings remain inside the Workbench.
- Adds Workbench resizing, minimize, and collapse controls, plus coding quick actions for explaining code, finding bugs, fixing errors, and generating tests.
- Keeps multi-agent coordination available for configured API-key agents.
- Keeps provider-specific request validation and regression tests.

# 0.4.14

- Fixes AI Workbench chat scrolling so long agent responses remain reachable while the prompt composer stays visible.
- Keeps the AI chat panel constrained to the available window height and enables contained vertical scrolling.

# 0.4.13

- Simplifies API key setup into one floating form for a user-defined name and key; provider is detected from supported key formats.
- Lets each saved key spawn 1–8 coworking agents that independently analyze the same project prompt, with optional coordinator synthesis.
- Adds key-specific AI request handling and regression coverage for the unified agent workflow.

# 0.4.12

- Replaces provider-separated API key sections with one unified saved-key list and a floating add-key panel for name, provider, and API key.
- Keeps per-key active selection, removal, local encrypted storage, and legacy-key migration.
- Adds UI regression coverage for adding multiple keys through the new panel.

# 0.4.11

- Adds an unlimited multi-key manager for OpenAI, Gemini, and Claude, with encrypted storage, labels, active-key selection, removal, and migration of previously saved single keys.
- Adds regression coverage for saving multiple keys under one provider and switching the active key.

# 0.4.10

- Corrects the multi-file Explorer UI regression selector and adds a Save & Close regression test for newly created files.
- Fixes the saved-tab identifier transition when closing a previously unsaved file after saving it.

# 0.4.9

- Fixes file-tab close handling with an accessible Save & Close / Close Without Saving / Cancel prompt.
- Adds left-click Explorer action buttons and right-click menus for running, side-by-side editing, open-with, reveal, compare, timeline, AI chat context, cut/copy/paste, path copying, rename, and delete.
- Restricts destructive Explorer operations to regular files within approved workspace paths and prevents overwriting existing destinations.

# 0.4.8

- Fixes the browser-style multi-file UI test selector and adds regression coverage for switching tabs while retaining independent unsaved edits.
- Corrects dirty-state indicators in the fallback editor mode.

# 0.4.7

- Adds browser-style multi-file tabs with independent editor models, unsaved-change indicators, tab switching, and close controls.

# 0.4.6

- Improves the AI workspace presentation with a more minimal, professional IDE layout.
- Keeps the installed-app automatic updater; this release makes the new UI available to existing installations through the normal update flow.

# 0.4.5

- Fixes terminal input being dropped when entered during compilation or process startup.
- Adds a C++ `std::cin` regression test for queued interactive input.

# 0.4.4

- Keeps automatic update checks available even when user plugin initialization fails.
- Shows a non-fatal startup warning for plugin failures and reconnects plugins after the app window is recreated.
- Adds regression coverage for startup ordering and retrying updates after network errors.

# 0.4.3

- Builds both platform installers without per-platform release uploads, then publishes a single unified GitHub Release with verified Windows and Linux update manifests.
- Retains persistent user plugins and the automatic update workflow.

# 0.4.2

- Fixes release-tag interpolation and ensures platform manifests are added to the same release as the Windows installer.
- Keeps persistent user plugins, local Monaco assets, and the in-app automatic updater.

# 0.4.1

- Keeps user-installed plugins in the persistent user profile so app updates do not overwrite them; adds Plugins > Open User Plugins Folder.
- Corrects release publishing so each version has one GitHub Release containing the Windows installer, Windows update manifest, Linux AppImage, and Linux update manifest.
- Upgrades Electron to the stable 45.x line and preserves all current editor, runner, AI-provider, and updater behavior.

# 0.4.0

- Adds a per-user Windows installer with GitHub Releases-based automatic updates.
- Checks for updates at launch and every four hours; available updates download in the background and prompt for restart.
- Adds Help > Check for Updates, a status-bar update control, and a persistent setting to disable automatic updates.
- Bundles Monaco locally so packaged builds load the editor from application resources rather than a development-time node_modules path or CDN.
- Adds release automation to verify tag/version consistency and publish Windows/Linux builds with updater metadata.
- Preserves the existing file editing, runner, AI-provider, and plugin-confirmation code paths.

## Important notes

- Download the installer once. After a new release is published, installed copies can download the update and apply it on restart or app quit.
- The public GitHub repository and internet access are required for tokenless updates.
- macOS auto-update requires signing and notarization; the automatic release workflow currently publishes Windows and Linux builds.
- Features described only in the separate v0.3 upgrade report are not claimed as included here because its referenced source ZIP was not supplied.
