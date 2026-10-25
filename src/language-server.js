'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LANGUAGE_SERVERS = {
  javascript: { command:'typescript-language-server', args:['--stdio'], label:'TypeScript language server' },
  typescript: { command:'typescript-language-server', args:['--stdio'], label:'TypeScript language server' },
  python: { command:'pylsp', args:[], label:'Python Language Server' },
  c: { command:'clangd', args:['--background-index=false'], label:'clangd' },
  cpp: { command:'clangd', args:['--background-index=false'], label:'clangd' },
  go: { command:'gopls', args:['serve'], label:'gopls' },
  rust: { command:'rust-analyzer', args:[], label:'rust-analyzer' }
};
const REQUEST_ALLOWLIST = new Set([
  'textDocument/definition', 'textDocument/references', 'textDocument/hover',
  'textDocument/completion', 'textDocument/formatting', 'textDocument/rename',
  'textDocument/documentSymbol', 'textDocument/typeDefinition', 'textDocument/implementation'
]);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function toUri(filePath) { return pathToFileURL(path.resolve(filePath)).href; }
function normalizePathForComparison(value) {
  let resolved = path.resolve(value);
  if (process.platform === 'win32') {
    // fs.realpath() may return Windows extended-length paths (\\\\?\\C:\\...),
    // while editor paths commonly arrive as ordinary drive-letter paths. Strip
    // the prefix before containment checks so equivalent paths compare safely.
    if (resolved.startsWith('\\\\?\\UNC\\')) resolved = '\\\\' + resolved.slice(8);
    else if (resolved.startsWith('\\\\?\\')) resolved = resolved.slice(4);
    resolved = path.win32.normalize(resolved).toLocaleLowerCase();
  }
  return resolved;
}

function insideRoot(root, target) {
  const normalizedRoot = normalizePathForComparison(root);
  const normalizedTarget = normalizePathForComparison(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

class LanguageServerManager {
  constructor({ onNotification = () => {}, serverConfigs = LANGUAGE_SERVERS } = {}) {
    this.onNotification = onNotification;
    this.serverConfigs = serverConfigs;
    this.session = null;
  }

  async start({ root, language }) {
    if (typeof root !== 'string' || root.length > 4096) throw new Error('Open a project folder before starting language intelligence.');
    const resolvedRoot = await fs.realpath(path.resolve(root));
    const stat = await fs.lstat(resolvedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Language server workspace must be a real directory.');
    const id = String(language || '').toLowerCase();
    const config = this.serverConfigs[id];
    if (!config) throw new Error('No language server is configured for ' + id + '. Supported integrations: JavaScript/TypeScript, Python, C/C++, Go and Rust.');
    await this.stop();
    let child;
    try {
      child = spawn(config.command, config.args || [], {
        cwd: resolvedRoot, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_NO_WARNINGS: '1' }
      });
    } catch (error) {
      throw new Error('Could not start ' + config.label + ': ' + error.message);
    }
    const session = {
      child, root: resolvedRoot, language: id, config, nextId: 1,
      pending: new Map(), documents: new Map(), buffer: Buffer.alloc(0),
      closed: false, started: false
    };
    this.session = session;
    child.stdout.on('data', chunk => this._readChunk(session, chunk));
    child.stderr.on('data', chunk => {
      const message = String(chunk).trim();
      if (message) this._emit('window/logMessage', { type: 3, message: '[' + config.label + '] ' + message.slice(0, 2000) });
    });
    child.on('error', error => this._closeSession(session, 'Could not start language server: ' + error.message));
    child.on('close', code => this._closeSession(session, 'Language server stopped (exit ' + code + ').'));
    const rootUri = toUri(resolvedRoot + path.sep);
    try {
      const response = await this._sendRequest(session, 'initialize', {
        processId: process.pid,
        clientInfo: { name:'Nidavellir', version:'0.4' },
        rootUri,
        rootPath: resolvedRoot,
        locale: 'en',
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: {
            applyEdit: false,
            workspaceFolders: true,
            configuration: true,
            workspaceEdit: { documentChanges: false, resourceOperations: [] },
            didChangeConfiguration: { dynamicRegistration: false }
          },
          textDocument: {
            synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
            hover: { dynamicRegistration: false, contentFormat: ['markdown','plaintext'] },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            typeDefinition: { dynamicRegistration: false, linkSupport: true },
            implementation: { dynamicRegistration: false, linkSupport: true },
            completion: {
              dynamicRegistration: false,
              completionItem: { snippetSupport: false, documentationFormat: ['markdown','plaintext'], resolveSupport: { properties: ['documentation','detail'] } }
            },
            formatting: { dynamicRegistration: false },
            rename: { dynamicRegistration: false, prepareSupport: true },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true }
          }
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(resolvedRoot) || resolvedRoot }]
      }, 15000);
      session.started = true;
      session.serverCapabilities = response && response.capabilities || {};
      this._sendNotification(session, 'initialized', {});
      this._sendNotification(session, 'workspace/didChangeConfiguration', { settings: {} });
      this._emit('nidavellir/languageServerState', {
        active: true, language: id, label: config.label, root: resolvedRoot,
        capabilities: Object.keys(session.serverCapabilities)
      });
      return { active:true, language:id, label:config.label, root:resolvedRoot, capabilities: Object.keys(session.serverCapabilities) };
    } catch (error) {
      await this.stop();
      throw new Error('Language server initialization failed: ' + error.message);
    }
  }

  async _assertDocument(root, filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.length > 4096) throw new Error('Save the file inside the opened workspace before using language intelligence.');
    const resolved = path.resolve(filePath);
    if (!insideRoot(root, resolved)) throw new Error('Language server requests are restricted to the opened workspace.');
    const actual = await fs.realpath(resolved);
    if (!insideRoot(root, actual)) throw new Error('Language server document path escapes the workspace.');
    const stat = await fs.lstat(actual);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Language server requires a regular file.');
    return actual;
  }

  async openDocument({ root, filePath, language, text }) {
    const session = await this._requireSession(root, language);
    const actual = await this._assertDocument(session.root, filePath);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Document is too large for language-server integration (2 MB limit).');
    const uri = toUri(actual);
    const previous = session.documents.get(uri);
    if (previous) {
      if (previous.text !== text) {
        previous.version++;
        previous.text = text;
        this._sendNotification(session, 'textDocument/didChange', {
          textDocument: { uri, version: previous.version },
          contentChanges: [{ text }]
        });
      }
      return { opened:true, uri, version:previous.version };
    }
    const doc = { uri, path:actual, languageId:session.language, text, version:1 };
    session.documents.set(uri, doc);
    this._sendNotification(session, 'textDocument/didOpen', {
      textDocument: { uri, languageId:doc.languageId, version:doc.version, text:doc.text }
    });
    return { opened:true, uri, version:doc.version };
  }

  async changeDocument({ root, filePath, language, text }) {
    return this.openDocument({ root, filePath, language, text });
  }

  async request({ root, filePath, language, text, method, position, newName, context }) {
    const session = await this._requireSession(root, language);
    if (!REQUEST_ALLOWLIST.has(method)) throw new Error('This language-server request is not allowed.');
    await this.openDocument({ root, filePath, language, text });
    const actual = await this._assertDocument(session.root, filePath);
    const uri = toUri(actual);
    const doc = session.documents.get(uri);
    let params;
    if (method === 'textDocument/formatting') {
      params = { textDocument:{ uri }, options:{ tabSize:2, insertSpaces:true } };
    } else if (method === 'textDocument/documentSymbol') {
      params = { textDocument:{ uri } };
    } else if (method === 'textDocument/rename') {
      if (typeof newName !== 'string' || !newName.trim() || newName.length > 200 || /[\0\r\n]/.test(newName)) throw new Error('Enter a valid new symbol name.');
      params = { textDocument:{ uri }, position:this._position(position), newName:newName.trim() };
    } else if (method === 'textDocument/references') {
      params = { textDocument:{ uri }, position:this._position(position), context: context && typeof context === 'object' ? { includeDeclaration: context.includeDeclaration !== false } : { includeDeclaration:true } };
    } else if (method === 'textDocument/completion') {
      params = { textDocument:{ uri }, position:this._position(position), context:{ triggerKind:1 } };
    } else {
      params = { textDocument:{ uri }, position:this._position(position) };
    }
    return this._sendRequest(session, method, params, 15000);
  }

  _position(position) {
    if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character) ||
        position.line < 0 || position.character < 0 || position.line > 1000000 || position.character > 1000000) {
      throw new Error('Invalid editor position.');
    }
    return { line:position.line, character:position.character };
  }

  async _requireSession(root, language) {
    const session = this.session;
    if (!session || session.closed || !session.started) throw new Error('Start a language server from Studio Tools first.');
    let canonicalRoot;
    try { canonicalRoot = await fs.realpath(path.resolve(root)); }
    catch { canonicalRoot = typeof root === 'string' ? path.resolve(root) : ''; }
    const sameRoot = process.platform === 'win32'
      ? canonicalRoot.toLocaleLowerCase() === session.root.toLocaleLowerCase()
      : canonicalRoot === session.root;
    if (typeof root !== 'string' || !sameRoot) throw new Error('Language server workspace changed; restart the server from Studio Tools.');
    if (String(language || '').toLowerCase() !== session.language) throw new Error('The active file uses a different language. Stop and start the matching language server.');
    return session;
  }

  _sendNotification(session, method, params) {
    if (session.closed || !session.child || session.child.killed || !session.child.stdin.writable) return;
    this._writeMessage(session.child, { jsonrpc:'2.0', method, params });
  }

  _sendRequest(session, method, params, timeoutMs = 10000) {
    if (session.closed) return Promise.reject(new Error('Language server is not running.'));
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error('Language server request timed out: ' + method));
      }, timeoutMs);
      session.pending.set(id, { resolve, reject, timer, method });
      try { this._writeMessage(session.child, { jsonrpc:'2.0', id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(error);
      }
    });
  }

  _writeMessage(child, message) {
    const json = Buffer.from(JSON.stringify(message), 'utf8');
    if (json.length > MAX_FRAME_BYTES) throw new Error('Language server message exceeds the size limit.');
    child.stdin.write(Buffer.concat([Buffer.from('Content-Length: ' + json.length + '\r\n\r\n'), json]));
  }

  _readChunk(session, chunk) {
    session.buffer = Buffer.concat([session.buffer, Buffer.from(chunk)]);
    if (session.buffer.length > MAX_FRAME_BYTES * 2) {
      this._closeSession(session, 'Language server output exceeded the buffer limit.');
      try { session.child.kill(); } catch {}
      return;
    }
    while (true) {
      const marker = session.buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const header = session.buffer.subarray(0, marker).toString('ascii');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        session.buffer = session.buffer.subarray(marker + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
        this._closeSession(session, 'Language server sent an invalid frame length.');
        try { session.child.kill(); } catch {}
        return;
      }
      const bodyStart = marker + 4;
      if (session.buffer.length < bodyStart + length) return;
      const body = session.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      session.buffer = session.buffer.subarray(bodyStart + length);
      let message;
      try { message = JSON.parse(body); } catch { continue; }
      this._handleMessage(session, message);
    }
  }

  _handleMessage(session, message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = session.pending.get(message.id);
      if (!pending) return;
      session.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || pending.method + ' failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const params = message.params || {};
      let result = null;
      if (message.method === 'workspace/configuration') result = Array.isArray(params.items) ? params.items.map(() => ({})) : [];
      else if (message.method === 'workspace/workspaceFolders') result = [{ uri:toUri(session.root + path.sep), name:path.basename(session.root) || session.root }];
      else if (message.method === 'workspace/applyEdit') result = { applied:false, failureReason:'Nidavellir requires workspace edits to be reviewed in the editor.' };
      this._writeMessage(session.child, { jsonrpc:'2.0', id:message.id, result });
      return;
    }
    if (message.method) {
      const params = message.params || {};
      if (message.method === 'textDocument/publishDiagnostics') {
        params.diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics.slice(0, 500) : [];
      }
      this._emit(message.method, params);
    }
  }

  _emit(method, params) {
    try { this.onNotification({ method, params }); } catch {}
  }

  _closeSession(session, reason) {
    if (session.closed) return;
    session.closed = true;
    for (const [, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    session.pending.clear();
    if (this.session === session) {
      this.session = null;
      this._emit('nidavellir/languageServerState', { active:false, language:session.language, label:session.config.label, message:reason });
    }
  }

  async stop() {
    const session = this.session;
    if (!session) return { stopped:true };
    if (!session.closed && session.started) {
      try { await this._sendRequest(session, 'shutdown', null, 800); } catch {}
      this._sendNotification(session, 'exit', {});
    }
    this.session = null;
    this._closeSession(session, 'Language server stopped.');
    try { session.child.kill(); } catch {}
    return { stopped:true };
  }
}

module.exports = { LanguageServerManager, LANGUAGE_SERVERS, REQUEST_ALLOWLIST };
