// src/safe-runner.js — safer snapshot-based project runner.
// IMPORTANT: this is a best-effort runner, NOT an OS security sandbox.
// Only run code you trust. Use a VM/container/OS sandbox for untrusted projects.
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');

const MAX_HISTORY = 10;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30_000;
// Compilers may be slow on first launch or on large projects; keep compile time separate from runtime.
const DEFAULT_COMPILE_TIMEOUT = 90_000;
const LANGUAGES = Object.freeze({
  javascript: '.js', python: '.py', cpp: '.cpp', c: '.c', java: '.java',
  go: '.go', rust: '.rs', ruby: '.rb', php: '.php', bash: '.sh', powershell: '.ps1'
});

function safeEnvironment() {
  // Do not pass API tokens and the full parent-process environment to project code.
  const env = {};
  const allow = process.platform === 'win32'
    ? ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  for (const key of allow) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try { child.kill(signal); } catch {}
    if (signal === 'SIGKILL') {
      try {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore', env: safeEnvironment()
        });
        killer.unref?.();
      } catch {}
    }
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}

function createSafeRunner(sendOutputFn) {
  let currentChild = null;
  let running = false;
  let acceptsInput = false;
  const history = [];
  function out(type, text) { sendOutputFn(type, String(text)); }

  async function run(payload = {}) {
    if (running) throw new Error('A process is already running. Stop it first.');
    if (!payload || typeof payload !== 'object') throw new Error('Invalid run request.');
    const { language, content, filePath } = payload;
    if (!Object.hasOwn(LANGUAGES, language)) throw new Error('Supported run targets: JavaScript, Python, C, C++, Java, Go, Rust, Ruby, PHP, Bash, and PowerShell.');
    if (typeof content !== 'string') throw new Error('Source code must be text.');
    if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Source file exceeds the 2 MB run limit.');
    if (filePath != null && (typeof filePath !== 'string' || filePath.length > 4096)) throw new Error('Invalid source file path.');

    const timeoutMs = Math.min(Math.max(Number.isFinite(Number(payload.timeout)) ? Number(payload.timeout) : DEFAULT_TIMEOUT, 1000), 120_000);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nidavellir-run-'));
    running = true;
    const ext = LANGUAGES[language];
    const fileName = filePath ? path.basename(filePath) : 'main' + ext;
    const source = path.join(tempDir, fileName.endsWith(ext) ? fileName : 'main' + ext);
    const originalDir = filePath ? path.dirname(path.resolve(filePath)) : tempDir;
    const startTime = Date.now();
    let command, args;
    try {
      // Never write editor contents back to the user's original source file.
      await fs.writeFile(source, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (['c', 'cpp', 'rust', 'java'].includes(language)) {
        const binary = path.join(tempDir, process.platform === 'win32' ? 'program.exe' : 'program');
        const compiler = ({ c: 'gcc', cpp: 'g++', rust: 'rustc', java: 'javac' })[language];
        out('info', 'Safety note: project code runs with your account permissions. Only run code you trust; this is not an OS sandbox.');
        out('info', `Compiling a temporary snapshot with ${compiler}…`);
        const includeArgs = filePath && ['c', 'cpp'].includes(language) ? ['-I', originalDir] : [];
        const compileArgs = language === 'java'
          ? [source, '-d', tempDir]
          : language === 'rust'
            ? [source, '-o', binary]
            : [source, ...includeArgs, '-o', binary];
        const compile = await execProcess(compiler, compileArgs, tempDir, Math.max(timeoutMs, DEFAULT_COMPILE_TIMEOUT), out, setChild);
        if (compile.code !== 0) {
          const diagnostics = [compile.stderr, compile.stdout].filter(Boolean).join('\n').trim();
          if (diagnostics) out('stderr', diagnostics);
          else if (compile.timedOut) out('stderr', `The ${compiler} compiler exceeded its ${Math.max(timeoutMs, DEFAULT_COMPILE_TIMEOUT) / 1000}s compilation limit. Check that the compiler installation is healthy and that no compiler process is waiting for input.`);
          else out('stderr', `Compilation failed (compiler exit code ${compile.code}) without diagnostic output.`);
          recordHistory(fileName, language, compile.code, Date.now() - startTime);
          return { code: compile.code, durationMs: Date.now() - startTime };
        }
        if (language === 'java') {
          command = 'java';
          args = ['-cp', tempDir, path.basename(source, '.java')];
        } else { command = binary; args = []; }
      } else if (language === 'javascript') {
        command = process.execPath; args = [source];
      } else if (language === 'python') {
        command = process.platform === 'win32' ? 'python' : 'python3'; args = [source];
      } else if (language === 'go') {
        command = 'go'; args = ['run', source];
      } else if (language === 'ruby') {
        command = 'ruby'; args = [source];
      } else if (language === 'php') {
        command = 'php'; args = [source];
      } else if (language === 'bash') {
        command = process.platform === 'win32' ? 'bash' : (process.env.SHELL || '/bin/bash');
        args = [source];
      } else {
        command = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
        args = ['-NoProfile', '-NonInteractive', '-File', source];
      }

      out('info', 'Safety note: project code runs with your account permissions. Only run code you trust; this is not an OS sandbox.');
      out('info', `Running temporary snapshot of ${fileName}…`);
      acceptsInput = true;
      const result = await execProcess(command, args, originalDir, timeoutMs, out, setChild, language === 'javascript' ? { ELECTRON_RUN_AS_NODE: '1' } : undefined, true);
      const durationMs = Date.now() - startTime;
      recordHistory(fileName, language, result.code, durationMs);
      out('exit', `Process exited with code ${result.code}`);
      return { code: result.code, durationMs };
    } finally {
      running = false;
      acceptsInput = false;
      currentChild = null;
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function setChild(child) { currentChild = child; }

  function execProcess(command, args, cwd, timeoutMs, output, setChildRef, extraEnv = {}, interactive = false) {
    return new Promise(resolve => {
      let settled = false, timedOut = false, outputBytes = 0, stdout = '', stderr = '', hardKill = null;
      let child;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
        if (currentChild === child) currentChild = null;
        resolve({ ...result, timedOut });
      };
      try {
        child = spawn(command, args, {
          cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: { ...safeEnvironment(), ...extraEnv },
          stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe']
        });
        setChildRef(child);
      } catch (e) {
        resolve({ code: 127, stdout: '', stderr: e.message }); return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        output('stderr', `\nProcess killed — exceeded ${timeoutMs / 1000}s ${interactive ? 'runtime' : 'compiler/process'} timeout.`);
        terminateProcessTree(child, 'SIGTERM');
        hardKill = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 1500);
        hardKill.unref?.();
      }, timeoutMs);
      timer.unref?.();

      const collect = (type, chunk) => {
        const text = chunk.toString();
        outputBytes += chunk.length;
        if (outputBytes <= MAX_OUTPUT_BYTES) {
          if (type === 'stdout') stdout += text; else stderr += text;
          output(type, text);
        } else if (outputBytes - chunk.length <= MAX_OUTPUT_BYTES) {
          output('stderr', '\n[Output truncated — exceeded 512 KB limit]');
        }
      };
      child.stdout.on('data', chunk => collect('stdout', chunk));
      child.stderr.on('data', chunk => collect('stderr', chunk));
      child.on('error', error => { output('stderr', error.message); finish({ code: 127, stdout, stderr: stderr || error.message }); });
      child.on('close', code => finish({ code: code ?? 1, stdout, stderr }));
    });
  }

  function writeInput(text) {
    if (!acceptsInput || !currentChild || !currentChild.stdin || currentChild.stdin.destroyed || !currentChild.stdin.writable) return false;
    if (typeof text !== 'string' || text.length > 16_384) return false;
    try { return currentChild.stdin.write(text); } catch { return false; }
  }

  function kill() {
    if (!currentChild) return false;
    try { currentChild.kill('SIGTERM'); } catch {}
    out('stderr', '\nStop requested. Child-process descendants may require OS-level containment.');
    return true;
  }

  function recordHistory(fileName, language, exitCode, durationMs) {
    history.unshift({ timestamp: new Date().toISOString(), fileName, language, exitCode, durationMs });
    if (history.length > MAX_HISTORY) history.pop();
  }
  return { run, kill, writeInput, getHistory: () => [...history], isRunning: () => running };
}

module.exports = { createSafeRunner, MAX_SOURCE_BYTES, MAX_OUTPUT_BYTES, LANGUAGES };
