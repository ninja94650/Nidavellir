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
