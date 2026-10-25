'use strict';
const {execFile}=require('node:child_process'),{promisify}=require('node:util'),execAsync=promisify(execFile);
const TOOLS=[
{id:'node',label:'Node.js',command:'node',args:['--version'],purpose:'Run JavaScript and development tools',install:'Install the current LTS release from https://nodejs.org/.'},
{id:'npm',label:'npm',command:'npm',args:['--version'],purpose:'Install JavaScript packages',install:'npm is bundled with Node.js.'},
{id:'python',label:'Python',candidates:[{command:'python',args:['--version']},{command:'python3',args:['--version']},{command:'py',args:['-V']}],purpose:'Run Python programs',install:'Install Python 3 from https://www.python.org/downloads/ and enable PATH integration.'},
{id:'gcc',label:'GCC (C)',command:'gcc',args:['--version'],purpose:'Compile C programs',install:'Install GCC through your platform package manager or a trusted Windows toolchain.'},
{id:'gpp',label:'G++ (C++)',command:'g++',args:['--version'],purpose:'Compile C++ programs',install:'Install G++ through your platform package manager or a trusted Windows toolchain.'},
{id:'clang',label:'Clang',command:'clang',args:['--version'],purpose:'Alternative C/C++ compiler',install:'Install LLVM from https://llvm.org/.'},
{id:'java',label:'Java JDK',command:'javac',args:['-version'],purpose:'Compile Java programs',install:'Install a JDK and configure PATH.'},
{id:'go',label:'Go',command:'go',args:['version'],purpose:'Build Go programs',install:'Install Go from https://go.dev/dl/.'},
{id:'rust',label:'Rust',command:'rustc',args:['--version'],purpose:'Compile Rust programs',install:'Install Rust from https://www.rust-lang.org/tools/install.'},
{id:'ruby',label:'Ruby',command:'ruby',args:['--version'],purpose:'Run Ruby programs',install:'Install Ruby from a trusted platform distribution.'},
{id:'php',label:'PHP',command:'php',args:['--version'],purpose:'Run PHP programs',install:'Install PHP CLI and add it to PATH.'},
{id:'powershell',label:'PowerShell 7',command:'pwsh',args:['-Version'],purpose:'Run cross-platform PowerShell scripts',install:'Install PowerShell 7 from https://learn.microsoft.com/powershell/.'},
{id:'git',label:'Git',command:'git',args:['--version'],purpose:'Track changes and collaborate',install:'Install Git from https://git-scm.com/downloads/.'}];
async function probe(tool,run=execAsync){const candidates=tool.candidates||[{command:tool.command,args:tool.args}];for(const c of candidates){try{const result=await run(c.command,c.args,{timeout:3500,windowsHide:true,maxBuffer:131072});return{id:tool.id,label:tool.label,available:true,command:c.command,version:String(result.stdout||result.stderr||'').trim().split(/\r?\n/)[0].slice(0,180),purpose:tool.purpose,install:tool.install};}catch(e){if(e&&['ENOENT','EACCES','EPERM'].includes(e.code))continue;if(e&&e.killed)return{id:tool.id,label:tool.label,available:false,command:c.command,version:null,purpose:tool.purpose,install:tool.install,note:'Version check timed out.'};}}return{id:tool.id,label:tool.label,available:false,command:candidates[0].command,version:null,purpose:tool.purpose,install:tool.install};}
async function checkEnvironment(run=execAsync){return{checkedAt:new Date().toISOString(),platform:process.platform,tools:await Promise.all(TOOLS.map(t=>probe(t,run)))};}
module.exports={checkEnvironment,probe,TOOLS};