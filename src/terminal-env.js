// Pass only a small, explicit set of development/runtime variables to the
// integrated terminal. A denylist cannot reliably identify custom secret names.
// This is defense in depth, not an OS sandbox: the shell still runs as the user.
const WINDOWS_ALLOWED = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_HOME',
  'MAVEN_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME',
  'PYTHONHOME', 'VIRTUAL_ENV', 'NVM_HOME', 'NVM_SYMLINK', 'NODE_HOME',
  'TERM', 'COLORTERM'
]);

const POSIX_ALLOWED = new Set([
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT',
  'GRADLE_HOME', 'MAVEN_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME',
  'RUSTUP_HOME', 'PYTHONHOME', 'VIRTUAL_ENV', 'NVM_DIR', 'NODE_HOME'
]);

const NUL = String.fromCharCode(0);

function buildTerminalEnvironment(source = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const allowed = windows ? WINDOWS_ALLOWED : POSIX_ALLOWED;
  const env = {};

  for (const [name, value] of Object.entries(source || {})) {
    const normalizedName = windows ? name.toUpperCase() : name;
    if (!allowed.has(normalizedName)) continue;
    if (typeof value !== 'string' || name.includes('=') || name.includes(NUL) || value.includes(NUL)) continue;
    env[name] = value;
  }

  return env;
}

module.exports = { buildTerminalEnvironment };
