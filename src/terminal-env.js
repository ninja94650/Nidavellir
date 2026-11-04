// Filter common credential-bearing environment variables before starting
// the integrated terminal. This is defense in depth, not an OS sandbox.
const SENSITIVE_ENV_NAME = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|AUTH(?:ORIZATION)?|COOKIE|SIGNING[_-]?KEY)/i;
const SENSITIVE_ENV_EXACT = new Set([
  'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'DOCKER_CONFIG', 'KUBECONFIG',
  'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'NPM_CONFIG_USERCONFIG',
  'NETRC', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH_COMMAND'
]);

function buildTerminalEnvironment(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (SENSITIVE_ENV_NAME.test(name) || SENSITIVE_ENV_EXACT.has(name.toUpperCase())) continue;
    if (typeof value !== 'string' || name.includes('=') || name.includes(String.fromCharCode(0)) || value.includes(String.fromCharCode(0))) continue;
    env[name] = value;
  }
  return env;
}

module.exports = { buildTerminalEnvironment };
