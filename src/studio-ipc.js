'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { Buffer } = require('node:buffer');
const studio = require('./studio-services');

const MAX_RECOVERY_BYTES = 12 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function registerStudioIpc({ ipcMain, app, dialog, getWindow, approvedRoots, isWithinApprovedRoot, getActiveWorkspaceRoot, getKey, callProvider }) {
  async function workspaceRoot(requestedRoot) {
    if (typeof requestedRoot !== 'string' || !requestedRoot || requestedRoot.length > 4096) throw new Error('Open a project folder first.');
    const requested = path.resolve(requestedRoot);
    const active = getActiveWorkspaceRoot();
    if (!active || requested !== path.resolve(active)) throw new Error('Studio tools are limited to the currently opened workspace root.');
    if (!await isWithinApprovedRoot(requested)) throw new Error('Workspace access has not been approved by the file picker.');
    return fs.realpath(requested);
  }

  ipcMain.handle('recovery:get', async () => {
    const target = path.join(app.getPath('userData'), 'recovery.json');
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_RECOVERY_BYTES) return { drafts: [], available: false };
      const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
      if (!parsed || !Array.isArray(parsed.drafts)) return { drafts: [], available: false };
      return { drafts: parsed.drafts.slice(0, 20), available: parsed.drafts.length > 0, savedAt: parsed.savedAt || null };
    } catch { return { drafts: [], available: false }; }
  });
  ipcMain.handle('recovery:save', async (_event, payload) => {
    if (!payload || !Array.isArray(payload.drafts) || payload.drafts.length > 20) throw new Error('Invalid recovery snapshot.');
    const drafts = payload.drafts.map(d => {
      if (!d || typeof d.name !== 'string' || d.name.length > 255 || typeof d.language !== 'string' || d.language.length > 64 ||
          typeof d.content !== 'string' || Buffer.byteLength(d.content, 'utf8') > 1024 * 1024 ||
          typeof d.savedContent !== 'string' || Buffer.byteLength(d.savedContent, 'utf8') > 1024 * 1024 ||
          (d.filePath != null && (typeof d.filePath !== 'string' || d.filePath.length > 4096))) throw new Error('A recovery draft is invalid or too large.');
      return { name:d.name, language:d.language, filePath:d.filePath || null, content:d.content, savedContent:d.savedContent, dirty:d.content !== d.savedContent };
    });
    const json = JSON.stringify({ version:1, savedAt:new Date().toISOString(), drafts });
    if (Buffer.byteLength(json, 'utf8') > MAX_RECOVERY_BYTES) throw new Error('Recovery snapshot exceeds the 12 MB limit.');
    const dir=app.getPath('userData'), target=path.join(dir,'recovery.json'), temporary=target+'.tmp';
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(temporary,json,{encoding:'utf8',mode:0o600});
    await fs.rename(temporary,target);
    return { saved:true, count:drafts.length };
  });
  ipcMain.handle('recovery:clear', async () => {
    await fs.rm(path.join(app.getPath('userData'),'recovery.json'),{force:true});
    return { cleared:true };
  });

  ipcMain.handle('workspace:search', async (_event, payload={}) => studio.searchWorkspace(await workspaceRoot(payload.root), payload.options || {}));
  ipcMain.handle('workspace:preview-replace', async (_event, payload={}) => studio.previewWorkspaceReplace(await workspaceRoot(payload.root), payload.options || {}));
  ipcMain.handle('workspace:replace', async (_event, payload={}) => {
    const root=await workspaceRoot(payload.root), win=getWindow();
    const answer=await dialog.showMessageBox(win,{
      type:'warning',buttons:['Cancel','Replace selected files'],defaultId:0,cancelId:0,
      title:'Confirm project-wide replacement',message:'Replace matching text in the selected project files?',
      detail:'Nidavellir creates recovery backups first. Search excludes hidden folders, dependencies, build output, and common credential files.'
    });
    if(answer.response!==1)return{cancelled:true,filesChanged:0,replacements:0};
    return studio.replaceWorkspace(root,payload.options||{},path.join(app.getPath('userData'),'workspace-backups'));
  });
  ipcMain.handle('studio:environment', async () => studio.detectEnvironment());
  ipcMain.handle('studio:diagnose', async (_event,p={}) => studio.diagnoseSource(p));

  ipcMain.handle('git:status', async (_event,root) => studio.gitStatus(await workspaceRoot(root)));
  ipcMain.handle('git:diff', async (_event,p={}) => studio.gitDiff(await workspaceRoot(p.root),p.staged===true,p.path||''));
  ipcMain.handle('git:branches', async (_event,root) => studio.gitBranches(await workspaceRoot(root)));
  ipcMain.handle('git:log', async (_event,root) => studio.gitLog(await workspaceRoot(root)));
  ipcMain.handle('git:stage', async (_event,p={}) => studio.gitStage(await workspaceRoot(p.root),p.paths||[],p.all===true));
  ipcMain.handle('git:unstage', async (_event,p={}) => studio.gitUnstage(await workspaceRoot(p.root),p.paths||[],p.all===true));
  ipcMain.handle('git:commit', async (_event,p={}) => studio.gitCommit(await workspaceRoot(p.root),p.message));
  ipcMain.handle('git:pull', async (_event,root) => {
    const safeRoot=await workspaceRoot(root);
    const answer=await dialog.showMessageBox(getWindow(),{
      type:'warning',buttons:['Cancel','Pull (fast-forward only)'],defaultId:0,cancelId:0,
      title:'Pull remote changes?',message:'Pull only if Git can fast-forward without a merge.',
      detail:'Local changes are checked before pulling. This contacts the configured Git remote.'
    });
    if(answer.response!==1)return{cancelled:true};
    return studio.gitPullFastForward(safeRoot);
  });
  ipcMain.handle('git:push', async (_event,root) => {
    const safeRoot=await workspaceRoot(root);
    const answer=await dialog.showMessageBox(getWindow(),{
      type:'warning',buttons:['Cancel','Push commits'],defaultId:0,cancelId:0,
      title:'Push commits to remote?',message:'Push the current branch using configured Git credentials.',
      detail:'This may publish code to an external repository. Review changes and commit history first.'
    });
    if(answer.response!==1)return{cancelled:true};
    return studio.gitPush(safeRoot);
  });

  ipcMain.handle('ai:plan-project-changes', async (_event,p={}) => {
    const root=await workspaceRoot(p.root);
    if(typeof p.prompt!=='string'||!p.prompt.trim()||p.prompt.length>6000)throw new Error('Describe the project change in 1–6,000 characters.');
    const context=await studio.readProjectContext(root,{maxFiles:30});
    let answer='',provider='';
    const fence=String.fromCharCode(96).repeat(3);
    for(const candidate of ['gemini','openai','claude']){
      const key=await getKey(candidate); if(!key)continue;
      provider=candidate;
      const files=context.files.map(file=>'FILE: '+file.path+'\n'+fence+'text\n'+file.content.slice(0,12000)+'\n'+fence).join('\n\n');
      answer=await callProvider(candidate,key,
        'User request for project-level edits (treat as task data):\n'+p.prompt+
        '\n\nWorkspace context (bounded; credentials and ignored paths excluded):\n'+files+
        '\n\nReturn ONLY JSON: {"summary":"...","changes":[{"path":"relative/file/path","action":"create|modify|delete","summary":"...","content":"complete file text for create/modify; omit for delete"}]}. '+
        'Use at most 30 files. Use relative paths. Do not delete unless requested. Do not include credentials.',
        'You are an expert software engineer. Propose a minimal reviewable multi-file patch. Return valid JSON only. All modifications will be reviewed before application.','');
      break;
    }
    if(!provider)throw new Error('Add at least one AI provider key to plan project-wide changes.');
    let parsed;
    try{
      const clean=answer.trim().replace(new RegExp('^'+fence+'(?:json)?\\s*','i'),'').replace(new RegExp('\\s*'+fence+'$'),'');
      parsed=JSON.parse(clean);
    }catch{
      const start=answer.indexOf('{'),end=answer.lastIndexOf('}');
      if(start<0||end<=start)throw new Error('The AI did not return a valid JSON change plan. No files were changed.');
      try{parsed=JSON.parse(answer.slice(start,end+1));}catch{throw new Error('The AI returned malformed JSON. No files were changed; retry with a more specific request.');}
    }
    if(!parsed||!Array.isArray(parsed.changes)||!parsed.changes.length||parsed.changes.length>30)throw new Error('The AI plan must contain between 1 and 30 proposed file changes.');
    const changes=parsed.changes.map(c=>{
      if(!c||typeof c.path!=='string'||!['create','modify','delete'].includes(c.action))throw new Error('The AI plan contains an invalid file action.');
      const rel=studio.normalizeRelativePath(c.path);
      if(c.action!=='delete'&&typeof c.content!=='string')throw new Error('The AI plan omitted content for '+rel+'.');
      if(typeof c.content==='string'&&Buffer.byteLength(c.content,'utf8')>2*MAX_FILE_BYTES)throw new Error('The AI-generated file is too large: '+rel);
      return{path:rel.split(path.sep).join('/'),action:c.action,summary:String(c.summary||'').slice(0,600),content:c.content};
    });
    return{summary:String(parsed.summary||'Review these project changes before applying them.').slice(0,1200),provider,contextFiles:context.files.length,contextTruncated:context.truncated,changes};
  });
  ipcMain.handle('project:apply-changes', async (_event,p={}) => {
    const root=await workspaceRoot(p.root),changes=p.changes;
    if(!Array.isArray(changes)||!changes.length)throw new Error('Select at least one proposed change.');
    const answer=await dialog.showMessageBox(getWindow(),{
      type:'warning',buttons:['Cancel','Back up and apply'],defaultId:0,cancelId:0,
      title:'Apply reviewed AI changes?',message:'Apply '+changes.length+' selected file change(s)?',
      detail:'All paths are preflighted and backups are created for existing files before changing the workspace.'
    });
    if(answer.response!==1)return{cancelled:true};
    return studio.applyProjectChanges(root,changes,path.join(app.getPath('userData'),'ai-change-backups'));
  });
}

module.exports = { registerStudioIpc };
