const fs = require('node:fs/promises');
const path = require('node:path');

async function copyMonaco() {
  const projectRoot = path.resolve(__dirname, '..');
  const source = path.join(projectRoot, 'node_modules', 'monaco-editor', 'min', 'vs');
  const destination = path.join(projectRoot, 'src', 'vendor', 'monaco', 'vs');
  await fs.access(path.join(source, 'loader.js'));
  await fs.rm(path.dirname(destination), { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
  return destination;
}
if (require.main === module) {
  copyMonaco().then(destination => process.stdout.write('Copied Monaco into ' + destination + '\n'))
    .catch(error => { process.stderr.write('Could not copy Monaco. Run npm install first.\n' + error.message + '\n'); process.exitCode = 1; });
}
module.exports = { copyMonaco };
