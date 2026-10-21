// src/safe-runner.js — Safe project runner for Nidavellir
// Wraps code execution with kill support, run history, output caps, and
// configurable timeouts.

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');

const MAX_HISTORY = 10;
const MAX_OUTPUT_BYTES = 512 * 1024;   // 500 KB
const DEFAULT_TIMEOUT = 30_000;

function createSafeRunner(sendOutputFn) {
  let currentChild = null;
  let running = false;
  const history = [];

  function out(type, text) { sendOutputFn(type, String(text)); }

  /* ── run ── */
  async function run(payload) {
    if (running) throw new Error('A process is already running. Stop it first.');

    const { language, content, filePath, timeout } = payload;
    const timeoutMs = Math.min(Math.max(timeout || DEFAULT_TIMEOUT, 1000), 120_000);
    const ext = { javascript: '.js', python: '.py', cpp: '.cpp', c: '.c' }[language];
    if (!ext) throw new Error('Supported run targets: JavaScript, Python, C, and C++.');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nidavellir-'));
    let source = filePath;
    let command, args, cwd = tempDir;

    if (!source) {
      source = path.join(tempDir, 'main' + ext);
      await fs.writeFile(source, content, 'utf8');
    } else {
      source = path.resolve(source);
      await fs.writeFile(source, content, 'utf8');
      cwd = path.dirname(source);
    }

    const startTime = Date.now();
    const fileName = path.basename(source);

    /* compile C / C++ */
    if (language === 'c' || language === 'cpp') {
      const binary = path.join(tempDir, process.platform === 'win32' ? 'program.exe' : 'program');
      const compiler = language === 'cpp' ? 'g++' : 'gcc';
      out('info', `Compiling with ${compiler}…`);
      const compile = await execProcess(compiler, [source, '-o', binary], cwd, timeoutMs);
      if (compile.code !== 0) {
        out('stderr', compile.stderr || compile.stdout || 'Compilation failed.');
        out('exit', `Compiler exited with code ${compile.code}`);
        recordHistory(fileName, language, compile.code, Date.now() - startTime);
        return { code: compile.code, durationMs: Date.now() - startTime };
      }
      command = binary; args = [];
    } else if (language === 'javascript') {
      command = process.execPath; args = [source];
    } else {
      command = process.platform === 'win32' ? 'python' : 'python3'; args = [source];
    }

    out('info', `Running ${fileName}…`);
    running = true;

    try {
      const result = await execProcess(command, args, cwd, timeoutMs);
      if (result.stdout) out('stdout', result.stdout);
      if (result.stderr) out('stderr', result.stderr);
      out('exit', `Process exited with code ${result.code}`);
      const durationMs = Date.now() - startTime;
      recordHistory(fileName, language, result.code, durationMs);
      return { code: result.code, durationMs };
    } finally {
      running = false;
      currentChild = null;
    }
  }

  /* ── internal process execution ── */
  function execProcess(command, args, cwd, timeoutMs) {
    return new Promise(resolve => {
      let stdout = '', stderr = '', settled = false, outputBytes = 0;
      let child;
      try {
        child = spawn(command, args, { cwd, shell: false, windowsHide: true });
      } catch (e) {
        resolve({ code: 127, stdout: '', stderr: e.message }); return;
      }
      currentChild = child;

      const timer = setTimeout(() => {
        out('stderr', `\nProcess killed — exceeded ${timeoutMs / 1000}s timeout.`);
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      }, timeoutMs);

      child.stdout.on('data', d => {
        const chunk = d.toString();
        outputBytes += d.length;
        if (outputBytes <= MAX_OUTPUT_BYTES) { stdout += chunk; out('stdout', chunk); }
        else if (outputBytes - d.length <= MAX_OUTPUT_BYTES) out('stderr', '\n[Output truncated — exceeded 500 KB limit]');
      });

      child.stderr.on('data', d => {
        const chunk = d.toString();
        outputBytes += d.length;
        if (outputBytes <= MAX_OUTPUT_BYTES) { stderr += chunk; out('stderr', chunk); }
      });

      child.on('error', e => {
        if (!settled) { settled = true; clearTimeout(timer); currentChild = null; resolve({ code: 127, stdout, stderr: e.message }); }
      });

      child.on('close', code => {
        if (!settled) { settled = true; clearTimeout(timer); currentChild = null; resolve({ code: code ?? 1, stdout, stderr }); }
      });
    });
  }

  /* ── kill ── */
  function kill() {
    if (!currentChild) return;
    try {
      currentChild.kill('SIGTERM');
      const ref = currentChild;
      setTimeout(() => { try { ref.kill('SIGKILL'); } catch {} }, 2000);
    } catch {}
    out('stderr', '\nProcess terminated by user.');
  }

  /* ── history ── */
  function recordHistory(fileName, language, exitCode, durationMs) {
    history.unshift({ timestamp: new Date().toISOString(), fileName, language, exitCode, durationMs });
    if (history.length > MAX_HISTORY) history.pop();
  }

  function getHistory() { return [...history]; }
  function isRunning()  { return running; }

  return { run, kill, getHistory, isRunning };
}

module.exports = { createSafeRunner };
