const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

async function generateUpdateManifest(platform, version, artifactPath, outputPath) {
  if (!['linux'].includes(platform)) throw new Error('This script currently generates the Linux updater manifest only.');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid semantic app version.');
  const artifactName = path.basename(artifactPath);
  const data = await fs.readFile(artifactPath);
  const stat = await fs.stat(artifactPath);
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  const releaseDate = new Date().toISOString();
  const yaml = [
    'version: ' + version,
    'files:',
    '  - url: ' + artifactName,
    '    sha512: ' + sha512,
    '    size: ' + stat.size,
    'path: ' + artifactName,
    'sha512: ' + sha512,
    "releaseDate: '" + releaseDate + "'",
    ''
  ].join('\n');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, yaml, 'utf8');
  return { outputPath, artifactName, size: stat.size, sha512, version };
}

if (require.main === module) {
  const [platform, version, artifact, output] = process.argv.slice(2);
  generateUpdateManifest(platform, version, artifact, output)
    .then(result => process.stdout.write('Generated ' + result.outputPath + ' for ' + result.artifactName + '\n'))
    .catch(error => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });
}

module.exports = { generateUpdateManifest };
