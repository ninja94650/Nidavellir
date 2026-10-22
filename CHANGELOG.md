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
