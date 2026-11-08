const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildTerminalEnvironment } = require('../src/terminal-env');

test('POSIX terminal environment uses an explicit development-variable allowlist', () => {
  const input = {
    PATH: '/usr/bin',
    HOME: '/home/test',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    JAVA_HOME: '/opt/java',
    ANDROID_HOME: '/opt/android',
    GOPATH: '/home/test/go',
    CARGO_HOME: '/home/test/.cargo',
    OPENAI_API_KEY: 'fake-openai-key',
    GITHUB_TOKEN: 'fake-github-token',
    CUSTOM_SECRET: 'fake-custom-secret',
    CUSTOM_FLAG: 'not-implicitly-trusted',
    NODE_OPTIONS: '--require /tmp/attacker.js',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    NPM_CONFIG_USERCONFIG: '/home/test/.npmrc',
    KUBECONFIG: '/home/test/.kube/config'
  };

  const filtered = buildTerminalEnvironment(input, 'linux');
  assert.deepEqual(filtered, {
    PATH: input.PATH,
    HOME: input.HOME,
    TMPDIR: input.TMPDIR,
    LANG: input.LANG,
    JAVA_HOME: input.JAVA_HOME,
    ANDROID_HOME: input.ANDROID_HOME,
    GOPATH: input.GOPATH,
    CARGO_HOME: input.CARGO_HOME
  });
});

test('Windows terminal environment allowlist is case-insensitive', () => {
  const input = {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\tester',
    JAVA_HOME: 'C:\\Java',
    ANDROID_SDK_ROOT: 'C:\\Android',
    OPENAI_API_KEY: 'fake-key',
    CUSTOM_SECRET: 'fake-secret',
    NODE_OPTIONS: '--require C:\\temp\\inject.js'
  };

  assert.deepEqual(buildTerminalEnvironment(input, 'win32'), {
    Path: input.Path,
    SystemRoot: input.SystemRoot,
    USERPROFILE: input.USERPROFILE,
    JAVA_HOME: input.JAVA_HOME,
    ANDROID_SDK_ROOT: input.ANDROID_SDK_ROOT
  });
});

test('terminal environment rejects invalid names and values', () => {
  const input = {
    PATH: '/bin',
    'PATH=INJECTED': '/attacker',
    BAD: 'value' + String.fromCharCode(0) + 'tail',
    ['BAD' + String.fromCharCode(0) + 'NAME']: 'value'
  };

  assert.deepEqual(buildTerminalEnvironment(input, 'linux'), { PATH: '/bin' });
});

test('terminal environment filtering does not mutate the parent environment', () => {
  const input = { PATH: '/bin', HOME: '/home/test', API_TOKEN: 'secret', CUSTOM_FLAG: 'not-allowed' };
  const before = { ...input };
  buildTerminalEnvironment(input, 'linux');
  assert.deepEqual(input, before);
});

test('integrated terminal uses the filtered environment helper', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.match(source, /require\\(['"]\\.\\/terminal-env['"]\\)/);
  assert.match(source, /env:\\s*buildTerminalEnvironment\\(\\)/);
  assert.doesNotMatch(source, /cwd,\\s*env:\\s*process\\.env,\\s*shell:\\s*false/);
});
