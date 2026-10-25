'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_RESULTS = 750;
const MAX_PROJECT_CONTEXT_BYTES = 120 * 1024;
const IGNORED_DIRS = new Set(['.git','node_modules','dist','build','out','coverage','.next','.cache','.venv','venv','__pycache__','.idea','target','vendor','.nidavellir-backups']);
const SENSITIVE_NAMES = new Set(['.env','.npmrc','.pypirc','id_rsa','id_ed25519','credentials.json','service-account.json']);
function isSensitiveFile(name) {
  const lower = String(name).toLowerCase();
  return SENSITIVE_NAMES.has(lower) || lower.startsWith('.env.') || ['.pem','.p12','.pfx','.key'].some(s => lower.endsWith(s));
}
function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1024 || relativePath.includes('\0')) throw new Error('Invalid workspace-relative path.');
  const normalized = relativePath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) throw new Error('Absolute paths are not allowed in workspace operations.');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Workspace paths cannot contain empty, dot, or parent-directory segments.');
  if (parts.some(part => IGNORED_DIRS.has(part) || isSensitiveFile(part))) throw new Error('This path is excluded from automated workspace operations.');
  return parts.join(path.sep);
}
function toDisplayPath(p) { return String(p).split(path.sep).join('/'); }
async function assertRealDirectory(root) {
  if (typeof root !== 'string' || root.length > 4096) throw new Error('Choose a project folder first.');
  const resolved = path.resolve(root), stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace root must be a real directory.');
  return fs.realpath(resolved);
}
async function assertNoSymlinkPath(root, relativePath, { allowMissingLeaf = false } = {}) {
  const relative = normalizeRelativePath(relativePath), target = path.resolve(root, relative), rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes the selected workspace.');
  const pieces = relative.split(path.sep); let cursor = root;
  for (let i=0; i<pieces.length; i++) {
    cursor = path.join(cursor, pieces[i]);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not accepted in workspace writes.');
      if (i < pieces.length-1 && !stat.isDirectory()) throw new Error('A parent path is not a directory.');
    } catch (error) {
      if (error.code === 'ENOENT' && (allowMissingLeaf || i < pieces.length-1)) continue;
      throw error;
    }
  }
  return target;
}
async function collectTextFiles(root, { maxFiles = MAX_SEARCH_FILES } = {}) {
  const files = [];
  async function visit(dir, depth) {
    if (depth > 20 || files.length >= maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(full, depth+1); continue; }
      if (!entry.isFile() || isSensitiveFile(entry.name)) continue;
      try { if ((await fs.stat(full)).size <= MAX_FILE_BYTES) files.push(full); } catch {}
    }
  }
  await visit(root,0); return files;
}
function buildMatcher(query, { matchCase = false, regex = false } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 250) throw new Error('Search text must contain 1–250 characters.');
  if (!regex) {
    const escaped = query.replace(/[.*+?^{}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, matchCase ? 'g' : 'gi');
  }
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(query) || /(?:\.\*){2,}/.test(query) || /\\[1-9]/.test(query)) throw new Error('This regular expression uses a potentially unsafe backtracking pattern.');
  try { return new RegExp(query, matchCase ? 'g' : 'gi'); }
  catch (error) { throw new Error('Invalid regular expression: ' + error.message); }
}
async function searchWorkspace(root, options = {}) {
  const realRoot = await assertRealDirectory(root), matcher = buildMatcher(options.query, options), files = await collectTextFiles(realRoot);
  const matches=[]; let totalMatches=0, filesScanned=0;
  for (const file of files) {
    if (matches.length >= MAX_SEARCH_RESULTS) break;
    let text;
    try { const buf=await fs.readFile(file); if (buf.includes(0)) continue; text=buf.toString('utf8'); if (text.includes('\uFFFD')) continue; } catch { continue; }
    filesScanned++;
    const lines=text.split(/\r?\n/);
    for(let i=0;i<lines.length && matches.length<MAX_SEARCH_RESULTS;i++){
      matcher.lastIndex=0; const found=matcher.exec(lines[i]); if(!found) continue;
      totalMatches++;
      matches.push({path:toDisplayPath(path.relative(realRoot,file)),line:i+1,column:found.index+1,text:lines[i].slice(0,600),match:found[0].slice(0,200)});
    }
  }
  return {root:realRoot,filesScanned,totalMatches,truncated:totalMatches>matches.length || files.length>=MAX_SEARCH_FILES,matches};
}
async function atomicWriteFile(target, content) {
  const temporary=target+'.nidavellir-'+process.pid+'-'+crypto.randomBytes(5).toString('hex')+'.tmp';
  try { await fs.writeFile(temporary,content,{encoding:'utf8',flag:'wx',mode:0o600}); await fs.rename(temporary,target); }
  catch(error){ await fs.rm(temporary,{force:true}).catch(()=>{}); throw error; }
}

async function previewWorkspaceReplace(root, options = {}) {
  const realRoot = await assertRealDirectory(root);
  if (!Array.isArray(options.paths) || !options.paths.length || options.paths.length > 500) throw new Error('Select between 1 and 500 files to preview.');
  if (typeof options.replacement !== 'string' || options.replacement.length > 10000) throw new Error('Replacement text must be no longer than 10,000 characters.');
  const paths = [...new Set(options.paths.map(normalizeRelativePath))];
  const previews = [];
  let replacements = 0;
  for (const relative of paths) {
    const target = await assertNoSymlinkPath(realRoot, relative);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Cannot safely preview replacement in ' + relative + '.');
    const original = await fs.readFile(target, 'utf8');
    if (original.includes('\0')) throw new Error('Binary content is not supported: ' + relative + '.');
    const count = (original.match(buildMatcher(options.query, options)) || []).length;
    if (!count) continue;
    const updated = original.replace(buildMatcher(options.query, options), options.replacement);
    if (updated === original) continue;
    replacements += count;
    const queryMatcher = buildMatcher(options.query, options);
    const index = queryMatcher.exec(original);
    const start = index ? Math.max(0, index.index - 180) : 0;
    const before = original.slice(start, start + 1600);
    const afterStart = Math.max(0, start - 20);
    const after = updated.slice(afterStart, afterStart + 1600);
    previews.push({ path: relative, replacements: count, before, after });
  }
  return {
    filesChanged: previews.length, replacements, previews,
    warning: 'Preview only; no files were modified. Confirm again to write the changes. Backups are created before applying.'
  };
}

async function replaceWorkspace(root, options = {}, backupRoot) {
  const realRoot=await assertRealDirectory(root);
  if(!Array.isArray(options.paths)||!options.paths.length||options.paths.length>500) throw new Error('Select between 1 and 500 files to replace.');
  if(typeof options.replacement!=='string'||options.replacement.length>10000) throw new Error('Replacement text must be no longer than 10,000 characters.');
  const matcher=buildMatcher(options.query,options), paths=[...new Set(options.paths.map(normalizeRelativePath))], prepared=[]; let replacementCount=0;
  for(const relative of paths){
    const target=await assertNoSymlinkPath(realRoot,relative), stat=await fs.lstat(target);
    if(!stat.isFile()||stat.size>MAX_FILE_BYTES) throw new Error('Cannot safely replace in '+relative+'.');
    const original=await fs.readFile(target,'utf8'); if(original.includes('\0')) throw new Error('Binary content is not supported: '+relative+'.');
    const countMatcher=buildMatcher(options.query,options); const count=(original.match(countMatcher)||[]).length;
    const updated=original.replace(buildMatcher(options.query,options),options.replacement);
    if(updated!==original){replacementCount+=count;prepared.push({relative,target,original,updated});}
  }
  if(!prepared.length)return {filesChanged:0,replacements:0,backups:[]};
  if(!backupRoot)throw new Error('Backup storage is unavailable; no files were changed.');
  const key=crypto.createHash('sha256').update(realRoot).digest('hex').slice(0,20);
  const backupDir=path.join(backupRoot,key,new Date().toISOString().replace(/[:.]/g,'-')); await fs.mkdir(backupDir,{recursive:true});
  const backedUp=[];
  for(const item of prepared){const backupPath=path.join(backupDir,item.relative);await fs.mkdir(path.dirname(backupPath),{recursive:true});await fs.writeFile(backupPath,item.original,{flag:'wx',mode:0o600});backedUp.push({relative:item.relative,backupPath});}
  const applied=[];
  try{for(const item of prepared){await atomicWriteFile(item.target,item.updated);applied.push(item);}}
  catch(error){for(const item of applied.reverse())await atomicWriteFile(item.target,item.original).catch(()=>{});throw new Error('Workspace replace failed and rollback was attempted: '+error.message);}
  return {filesChanged:prepared.length,replacements:replacementCount,backups:backedUp};
}
const TOOLS=[
 ['Node.js','node',['--version'],'runtime'],['npm','npm',['--version'],'package manager'],
 ['Python','python',['--version'],'runtime'],['Python 3','python3',['--version'],'runtime'],
 ['C compiler (gcc)','gcc',['--version'],'compiler'],['C++ compiler (g++)','g++',['--version'],'compiler'],['Clang','clang',['--version'],'compiler'],
 ['Java runtime','java',['-version'],'runtime'],['Java compiler','javac',['-version'],'compiler'],['Go','go',['version'],'runtime/compiler'],
 ['Rust compiler','rustc',['--version'],'compiler'],['Cargo','cargo',['--version'],'package manager'],['Ruby','ruby',['--version'],'runtime'],['PHP','php',['--version'],'runtime'],
 ['Bash','bash',['--version'],'shell'],['PowerShell','pwsh',['-Version'],'shell'],['Git','git',['--version'],'version control'],
 ['GDB','gdb',['--version'],'debugger'],['LLDB','lldb',['--version'],'debugger'],['clangd','clangd',['--version'],'language server'],
 ['Python language server','pylsp',['--version'],'language server'],['Go language server','gopls',['version'],'language server'],
 ['TypeScript language server','typescript-language-server',['--version'],'language server']
];
async function checkTool([name,command,args,category]){
 try{const r=await execFileAsync(command,args,{timeout:2200,windowsHide:true,maxBuffer:16384});const v=String(r.stdout||r.stderr||'').trim().split(/\r?\n/)[0].slice(0,240);return{name,command,category,available:true,version:v||'Installed (version not reported)'};}
 catch(error){if(error&&(error.code==='ENOENT'||error.code==='EACCES'))return{name,command,category,available:false,version:''};const v=String(error&&(error.stdout||error.stderr)||'').trim().split(/\r?\n/)[0].slice(0,240);if(error&&error.code!=='ETIMEDOUT'&&v)return{name,command,category,available:true,version:v};return{name,command,category,available:false,version:error&&error.code==='ETIMEDOUT'?'Version check timed out':''};}
}
async function detectEnvironment(){const tools=await Promise.all(TOOLS.map(checkTool));const dedup=new Map();for(const t of tools){const key=t.category+':'+t.command;if(!dedup.has(key)||(!dedup.get(key).available&&t.available))dedup.set(key,t);}return{platform:process.platform,nodeRuntime:process.versions.node,electronRuntime:process.versions.electron||'not running inside Electron',scannedAt:new Date().toISOString(),tools:[...dedup.values()]};}
function gitExec(root,args,options={}){if(!Array.isArray(args)||args.some(x=>typeof x!=='string'||x.length>2000||x.includes('\0')))throw new Error('Invalid Git arguments.');return execFileAsync('git',['-C',root,...args],{timeout:options.timeout||12000,windowsHide:true,maxBuffer:options.maxBuffer||1024*1024,encoding:'utf8'});}
async function assertGitRoot(root){const real=await assertRealDirectory(root),r=await gitExec(real,['rev-parse','--show-toplevel']),top=await fs.realpath(String(r.stdout).trim());if(top!==real)throw new Error('Open the actual Git repository root before using Git actions.');return real;}
async function gitStatus(root){
 const real=await assertGitRoot(root),[s,b,d,sd,remote]=await Promise.all([
 gitExec(real,['status','--porcelain=v1','-z','--untracked-files=all']),gitExec(real,['branch','--show-current']),
 gitExec(real,['diff','--stat','--no-ext-diff','--no-color']),gitExec(real,['diff','--cached','--stat','--no-ext-diff','--no-color']),
 gitExec(real,['remote','-v']).catch(()=>({stdout:''}))]);
 const changes=String(s.stdout).split('\0').filter(Boolean).map(entry=>({index:entry[0]||' ',worktree:entry[1]||' ',status:(entry[0]+entry[1]).trim()||'??',path:entry.slice(3)}));
 return{root:real,branch:String(b.stdout).trim()||'(detached HEAD)',changes,workingDiff:String(d.stdout).slice(0,20000),stagedDiff:String(sd.stdout).slice(0,20000),hasRemote:Boolean(String(remote.stdout).trim())};
}
async function gitDiff(root,staged=false,relativePath=''){const real=await assertGitRoot(root),args=['diff','--no-ext-diff','--no-color','--no-renames'];if(staged)args.push('--cached');if(relativePath)args.push('--',normalizeRelativePath(relativePath));return String((await gitExec(real,args,{timeout:15000,maxBuffer:512*1024})).stdout).slice(0,250000);}
async function gitBranches(root){const real=await assertGitRoot(root),r=await gitExec(real,['branch','--format=%(refname:short)|%(HEAD)|%(upstream:short)']);return String(r.stdout).split(/\r?\n/).filter(Boolean).map(line=>{const[n,c,u]=line.split('|');return{name:n,current:c==='*',upstream:u||''};});}

function validateBranchName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 120 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ||
      name.includes('..') || name.includes('//') || name.includes('@{') ||
      name.endsWith('/') || name.endsWith('.') || name.toLowerCase().endsWith('.lock')) {
    throw new Error('Branch name is invalid. Use letters, numbers, dots, underscores, slashes or hyphens, and do not start with punctuation.');
  }
  return name;
}
async function gitSwitchBranch(root, branchName) {
  const real = await assertGitRoot(root);
  const name = validateBranchName(branchName);
  const branches = await gitBranches(real);
  if (!branches.some(branch => branch.name === name)) throw new Error('That local branch does not exist. Create it or fetch it first.');
  const status = await gitStatus(real);
  if (status.changes.length) throw new Error('Commit or stash local changes before switching branches. Nidavellir will not overwrite a dirty working tree.');
  const result = await gitExec(real, ['switch', name], { timeout: 30000 });
  return { output: String(result.stdout || result.stderr || '').slice(0, 10000), status: await gitStatus(real), branches: await gitBranches(real) };
}
async function gitCreateBranch(root, branchName) {
  const real = await assertGitRoot(root);
  const name = validateBranchName(branchName);
  const status = await gitStatus(real);
  if (status.changes.length) throw new Error('Commit or stash local changes before creating a branch.');
  const branches = await gitBranches(real);
  if (branches.some(branch => branch.name === name)) throw new Error('A local branch with that name already exists.');
  const result = await gitExec(real, ['switch', '-c', name], { timeout: 30000 });
  return { output: String(result.stdout || result.stderr || '').slice(0, 10000), status: await gitStatus(real), branches: await gitBranches(real) };
}

async function gitStage(root,paths=[],all=false){const real=await assertGitRoot(root);if(all)await gitExec(real,['add','--all']);else{if(!Array.isArray(paths)||!paths.length||paths.length>300)throw new Error('Select files to stage.');await gitExec(real,['add','--',...new Set(paths.map(normalizeRelativePath))]);}return gitStatus(real);}
async function gitUnstage(root,paths=[],all=false){const real=await assertGitRoot(root);if(all)await gitExec(real,['restore','--staged','--','.']);else{if(!Array.isArray(paths)||!paths.length||paths.length>300)throw new Error('Select files to unstage.');await gitExec(real,['restore','--staged','--',...new Set(paths.map(normalizeRelativePath))]);}return gitStatus(real);}
async function gitCommit(root,message){const real=await assertGitRoot(root);if(typeof message!=='string'||!message.trim()||message.trim().length>500||/[\0\r]/.test(message))throw new Error('Commit message must contain 1–500 characters.');const s=await gitStatus(real);if(!s.changes.some(c=>c.index!==' '&&c.index!=='?'))throw new Error('Nothing is staged. Stage at least one change before committing.');const r=await gitExec(real,['commit','-m',message.trim()],{timeout:30000});return{output:String(r.stdout||r.stderr).slice(0,10000),status:await gitStatus(real)};}
async function gitPullFastForward(root){const real=await assertGitRoot(root),s=await gitStatus(real);if(s.changes.length)throw new Error('Commit or stash local changes before pulling. Nidavellir will not overwrite a dirty working tree.');const r=await gitExec(real,['pull','--ff-only'],{timeout:60000,maxBuffer:131072});return{output:String(r.stdout||r.stderr).slice(0,12000),status:await gitStatus(real)};}
async function gitPush(root){const real=await assertGitRoot(root),r=await gitExec(real,['push'],{timeout:60000,maxBuffer:131072});return{output:String(r.stdout||r.stderr).slice(0,12000),status:await gitStatus(real)};}
async function gitLog(root){const real=await assertGitRoot(root),r=await gitExec(real,['log','-n','20','--pretty=format:%h%x09%ad%x09%s','--date=short']);return String(r.stdout).slice(0,12000).split(/\r?\n/).filter(Boolean).map(line=>{const[h,d,...s]=line.split('\t');return{hash:h,date:d,subject:s.join('\t')};});}
async function readProjectContext(root,{maxFiles=30}={}){const real=await assertRealDirectory(root),files=await collectTextFiles(real,{maxFiles:Math.min(Math.max(maxFiles,1),100)}),context=[];let size=0;for(const file of files){const remaining=MAX_PROJECT_CONTEXT_BYTES-size;if(remaining<=100)break;try{const buf=await fs.readFile(file);if(buf.includes(0))continue;const text=buf.toString('utf8');if(text.includes('\uFFFD'))continue;const snippet=text.slice(0,remaining);context.push({path:toDisplayPath(path.relative(real,file)),content:snippet});size+=Buffer.byteLength(snippet);}catch{}}return{root:real,files:context,truncated:size>=MAX_PROJECT_CONTEXT_BYTES};}
async function applyProjectChanges(root,changes,backupRoot){
 const real=await assertRealDirectory(root);if(!Array.isArray(changes)||!changes.length||changes.length>30)throw new Error('A change set must contain 1–30 files.');if(typeof backupRoot!=='string'||!backupRoot)throw new Error('Backup storage is unavailable.');
 const seen=new Set(),prepared=[];let total=0;
 for(const c of changes){if(!c||!['create','modify','delete'].includes(c.action))throw new Error('Unsupported change action.');const rel=normalizeRelativePath(c.path);if(seen.has(rel))throw new Error('Duplicate path in change set: '+rel);seen.add(rel);const target=await assertNoSymlinkPath(real,rel,{allowMissingLeaf:c.action==='create'});let original=null;
  try{const st=await fs.lstat(target);if(st.isSymbolicLink()||!st.isFile()||st.size>2*MAX_FILE_BYTES)throw new Error('Target is not a regular safe file: '+rel);original=await fs.readFile(target,'utf8');if(c.action==='create')throw new Error('Cannot create '+rel+': it already exists.');}
  catch(e){if(e.code==='ENOENT'&&c.action==='create')original=null;else throw e;}
  if(c.action!=='create'&&original==null)throw new Error('Cannot '+c.action+' '+rel+': file does not exist.');
  if(c.action==='delete')prepared.push({path:rel,action:c.action,target,original});
  else{if(typeof c.content!=='string')throw new Error('Missing text content for '+rel+'.');const bytes=Buffer.byteLength(c.content);total+=bytes;if(bytes>2*MAX_FILE_BYTES||total>10*MAX_FILE_BYTES)throw new Error('Change set exceeds the 10 MB text limit.');prepared.push({path:rel,action:c.action,target,original,content:c.content});}
 }
 const key=crypto.createHash('sha256').update(real).digest('hex').slice(0,20),backupDir=path.join(backupRoot,key,new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(backupDir,{recursive:true});
 for(const item of prepared){if(item.original==null)continue;const backup=path.join(backupDir,item.path);await fs.mkdir(path.dirname(backup),{recursive:true});await fs.writeFile(backup,item.original,{flag:'wx',mode:0o600});}
 const applied=[];
 try{for(const item of prepared){if(item.action==='delete')await fs.unlink(item.target);else{await fs.mkdir(path.dirname(item.target),{recursive:true});await atomicWriteFile(item.target,item.content);}applied.push(item);}}
 catch(error){for(const item of applied.reverse()){try{if(item.original==null)await fs.rm(item.target,{force:true});else await atomicWriteFile(item.target,item.original);}catch{}}throw new Error('Applying project changes failed; rollback was attempted and backups were retained: '+error.message);}
 return{applied:prepared.map(x=>({path:x.path,action:x.action})),backupDir,count:prepared.length};
}

async function diagnoseSource(options = {}) {
  const language = String(options.language || '').toLowerCase();
  const content = options.content;
  const filename = typeof options.fileName === 'string' ? path.basename(options.fileName) : 'source';
  if (typeof content !== 'string') throw new Error('Source code must be text.');
  if (Buffer.byteLength(content, 'utf8') > 2 * MAX_FILE_BYTES) throw new Error('Source is larger than the 2 MB diagnostic limit.');
  if (language === 'json') {
    try { JSON.parse(content); return { status: 'passed', tool: 'built-in JSON parser', diagnostics: 'JSON syntax is valid.' }; }
    catch (error) { return { status: 'issues', tool: 'built-in JSON parser', diagnostics: error.message }; }
  }
  const extension = ({ javascript:'.js', typescript:'.ts', python:'.py', c:'.c', cpp:'.cpp', java:'.java', rust:'.rs', ruby:'.rb', php:'.php', bash:'.sh' })[language];
  if (!extension) return { status:'unsupported', tool:'language service', diagnostics:'No local syntax checker is configured for '+language+'.' };
  const tempDir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'nidavellir-diagnose-'));
  try {
    const stem = filename && filename !== '.' && filename !== '..' ? filename : 'source'+extension;
    const finalName = stem.toLowerCase().endsWith(extension) ? stem : path.basename(stem, path.extname(stem))+extension;
    const source = path.join(tempDir, finalName);
    await fs.writeFile(source, content, { encoding:'utf8', flag:'wx', mode:0o600 });
    let command, args;
    if (language === 'javascript') { command='node'; args=['--check',source]; }
    else if (language === 'typescript') { command='tsc'; args=['--noEmit','--pretty','false','--skipLibCheck',source]; }
    else if (language === 'python') { command=process.platform === 'win32' ? 'python' : 'python3'; args=['-m','py_compile',source]; }
    else if (language === 'c') { command='gcc'; args=['-fsyntax-only',source]; }
    else if (language === 'cpp') { command='g++'; args=['-fsyntax-only',source]; }
    else if (language === 'java') { command='javac'; args=['-Xlint:all','-d',tempDir,source]; }
    else if (language === 'rust') { command='rustc'; args=['--crate-type','lib','--emit=metadata','-o',path.join(tempDir,'diagnostic.rmeta'),source]; }
    else if (language === 'ruby') { command='ruby'; args=['-c',source]; }
    else if (language === 'php') { command='php'; args=['-l',source]; }
    else { command='bash'; args=['-n',source]; }
    if (options.filePath && ['c','cpp'].includes(language)) args.splice(1,0,'-I',path.dirname(path.resolve(options.filePath)));
    try {
      const result = await execFileAsync(command,args,{cwd:tempDir,timeout:15000,windowsHide:true,maxBuffer:128*1024,encoding:'utf8'});
      return {status:'passed',tool:command,diagnostics:String(result.stdout||result.stderr||'Syntax check passed.').trim().slice(0,12000)||'Syntax check passed.'};
    } catch(error) {
      if (error && error.code === 'ENOENT') return {status:'unavailable',tool:command,diagnostics:command+' was not found. Install it and ensure it is on PATH.'};
      const output=String(error&&(error.stderr||error.stdout)||error.message||'Diagnostic failed.').trim().slice(0,12000);
      return {status:error&&error.code==='ETIMEDOUT'?'timeout':'issues',tool:command,diagnostics:output||'Syntax check reported an issue.'};
    }
  } finally { await fs.rm(tempDir,{recursive:true,force:true}).catch(()=>{}); }
}

module.exports={IGNORED_DIRS,SENSITIVE_NAMES,normalizeRelativePath,assertRealDirectory,collectTextFiles,searchWorkspace,previewWorkspaceReplace,replaceWorkspace,detectEnvironment,diagnoseSource,gitStatus,gitDiff,gitBranches,gitSwitchBranch,gitCreateBranch,gitStage,gitUnstage,gitCommit,gitPullFastForward,gitPush,gitLog,readProjectContext,applyProjectChanges};
