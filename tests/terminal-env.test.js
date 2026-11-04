const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildTerminalEnvironment } = require('../src/terminal-env');

test('terminal environment filters common credential-bearing variable names', () => {
  const input = {
    PATH: '/usr/bin',
    HOME: '/home/test',
    JAVA_HOME: '/opt/java',
    ANDROID_HOME: '/opt/android',
    OPENAI_API_KEY: 'fake-openai-key',
    GITHUB_TOKEN: 'fake-github-token',
    AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
    NODE_AUTH_TOKEN: 'fake-npm-token',
    CLIENT_SECRET: 'fake-client-secret',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    NPM_CONFIG_USERCONFIG: '/home/test/.npmrc',
    KUBECONFIG: '/home/test/.kube/config'
  };

  const filtered = buildTerminalEnvironment(input);
  assert.equal(filtered.PATH, input.PATH);
  assert.equal(filtered.HOME, input.HOME);
  assert.equal(filtered.JAVA_HOME, input.JAVA_HOME);
  assert.equal(filtered.ANDROID_HOME, input.ANDROID_HOME);
  for (const name of [
    'OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY',
    'NODE_AUTH_TOKEN', 'CLIENT_SECRET', 'SSH_AUTH_SOCK',
    'NPM_CONFIG_USERCONFIG', 'KUBECONFIG'
  ]) assert.equal(Object.hasOwn(filtered, name), false, name + ' must not be inherited');
});

test('terminal environment filtering does not mutate the parent environment', () => {
  const input = { PATH: '/bin', CUSTOM_FLAG: 'kept', API_TOKEN: 'secret' };
  const before = { ...input };
  buildTerminalEnvironment(input);
  assert.deepEqual(input, before);
});

test('integrated terminal uses the filtered environment helper', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.match(source, /require\(['"]\.\/terminal-env['"]\)/);
  assert.match(source, /env:\s*buildTerminalEnvironment\(\)/);
  assert.doesNotMatch(source, /cwd,\s*env:\s*process\.env,\s*shell:\s*false/);
});
