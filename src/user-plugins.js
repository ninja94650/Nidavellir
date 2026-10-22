const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Creates a user-owned plugin directory and copies any bundled examples that
 * are not already present. Existing user folders are never overwritten, so
 * locally installed plugins survive application upgrades.
 */
async function prepareUserPluginsDir(userDataDir, bundledPluginsDir) {
  if (typeof userDataDir !== 'string' || !userDataDir) throw new TypeError('A user-data directory is required.');
  if (typeof bundledPluginsDir !== 'string' || !bundledPluginsDir) throw new TypeError('A bundled-plugins directory is required.');

  const userPluginsDir = path.join(userDataDir, 'plugins');
  await fs.mkdir(userPluginsDir, { recursive: true });

  let entries = [];
  try {
    entries = await fs.readdir(bundledPluginsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return userPluginsDir;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.' || entry.name === '..') continue;
    const source = path.join(bundledPluginsDir, entry.name);
    const target = path.join(userPluginsDir, entry.name);
    try {
      await fs.lstat(target);
      // An installed/modified plugin has priority over a bundled example.
      continue;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
    } catch (error) {
      // Tolerate a concurrent first-launch attempt creating the same folder.
      if (error && (error.code === 'EEXIST' || error.code === 'ERR_FS_CP_EEXIST')) continue;
      throw error;
    }
  }
  return userPluginsDir;
}

module.exports = { prepareUserPluginsDir };
