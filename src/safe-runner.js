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

function terminateProcessTree(child) {
  if (!child || !child.pid) return Promise.resolve();

  if (process.platform === 'win32') {
    // child.kill() only guarantees termination of the direct child on Windows.
    // Start taskkill while the root PID is still alive, and wait for it to finish
    // so descendants cannot keep using the temporary workspace after cleanup.
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fallback = () => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch {}
        finish();
      };
      try {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore', env: safeEnvironment()
        });
        killer.once('error', fallback);
        killer.once('close', code => {
          if (code !== 0) fallback();
          else finish();
        });
      } catch {
        fallback();
      }
    });
  }

  // Spawned runners are detached on POSIX, so their PID is also the process
  // group ID. Signal the group, then force-kill the group after a grace period
  // even if the original parent exits first; grandchildren may still be alive.
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch { try { child.kill('SIGTERM'); } catch {} }
  return new Promise(resolve => {
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch {} }
      resolve();
    }, 1500);
  });
}

function createSafeRunner(sendOutputFn) {
  let currentChild = null;
  let currentTermination = null;
  let running = false;
  let acceptsInput = false;
  let pendingInput = '';
  const MAX_PENDING_INPUT = 16_384;
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
    pendingInput = '';
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
        const compile = await execProcess(compiler, compileArgs, tempDir, timeoutMs, out, setChild);
        if (compile.code !== 0) {
          out('stderr', compile.stderr || compile.stdout || 'Compilation failed.');
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
      pendingInput = '';
      currentChild = null;
      currentTermination = null;
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function setChild(child) {
    currentChild = child;
    currentTermination = null;
    // Input typed while compilation is finishing is delivered as soon as the
    // interactive program's stdin pipe exists. Compiler stdin is ignored.
    if (pendingInput && acceptsInput && child?.stdin && !child.stdin.destroyed && child.stdin.writable) {
      const queued = pendingInput;
      pendingInput = '';
      try {
        if (!child.stdin.write(queued)) {
          // The stream accepted the chunk into its backpressure buffer; do not replay it.
        }
      } catch {
        pendingInput = queued;
      }
    }
  }

  function execProcess(command, args, cwd, timeoutMs, output, setChildRef, extraEnv = {}, interactive = false) {
    return new Promise(resolve => {
      let settled = false, finishing = false, outputBytes = 0, stdout = '', stderr = '';
      let child;
      const finish = result => {
        if (settled || finishing) return;
        finishing = true;
        // Do not resolve the run or remove its snapshot until process-tree
        // termination has completed, including Windows taskkill /T /F.
        Promise.resolve(currentTermination).catch(() => {}).then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (currentChild === child) currentChild = null;
          resolve(result);
        });
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
        output('stderr', `\nProcess killed — exceeded ${timeoutMs / 1000}s timeout.`);
        currentTermination = terminateProcessTree(child);
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
    if (typeof text !== 'string' || text.length > MAX_PENDING_INPUT || !running) return false;
    if (!acceptsInput || !currentChild || !currentChild.stdin || currentChild.stdin.destroyed || !currentChild.stdin.writable) {
      if (pendingInput.length + text.length > MAX_PENDING_INPUT) return false;
      pendingInput += text;
      return true;
    }
    try { return currentChild.stdin.write(text); } catch { return false; }
  }

  function kill() {
    const child = currentChild;
    if (!child) return false;
    // Termination is tracked by execProcess so its completion waits for the
    // full tree to exit, even if the root process closes before its descendants.
    currentTermination = terminateProcessTree(child);
    out('stderr', '\nStop requested. Terminating the process tree…');
    return true;
  }

  function recordHistory(fileName, language, exitCode, durationMs) {
    history.unshift({ timestamp: new Date().toISOString(), fileName, language, exitCode, durationMs });
    if (history.length > MAX_HISTORY) history.pop();
  }
  return { run, kill, writeInput, getHistory: () => [...history], isRunning: () => running };
}

module.exports = { createSafeRunner, MAX_SOURCE_BYTES, MAX_OUTPUT_BYTES, LANGUAGES };
