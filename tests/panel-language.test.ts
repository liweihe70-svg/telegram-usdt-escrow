import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const panel:any=await import(new URL('../../public/panel-i18n.js',import.meta.url).href);
test('面板语言独立记忆，HTML仅翻译系统字面量并保留用户内容',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),saved=new Map<string,string>();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)}});
 try{panel.setLanguage('en');assert.equal(panel.getLanguage(),'en');assert.equal(saved.get('escrow.panel.language'),'en');assert.equal(panel.locale(),'en-US');
  assert.equal(panel.h`<h3>交易约定</h3>${'交易约定：已完成，买家要求中文交付'}`,'<h3>Trade terms</h3>交易约定：已完成，买家要求中文交付');
  assert.equal(panel.T('维护与备份'),'Maintenance & backups');assert.equal(panel.errorText('恢复密码不正确，或备份文件损坏'),'Incorrect recovery password or damaged backup file');
  assert(!/[\u3400-\u9fff]/.test(panel.errorText('未收录的后台系统错误')));
  panel.setLanguage('zh');assert.equal(panel.h`<h3>交易约定</h3>${'原文'}`,'<h3>交易约定</h3>原文');assert.equal(saved.get('escrow.panel.language'),'zh');
 }finally{panel.setLanguage('zh');if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete (globalThis as any).localStorage;}
});
test('面板全部静态中文文案有英文覆盖，包括动态模板和可访问性属性',async()=>{
 panel.setLanguage('en');try{
  const source=await readFile(new URL('../../public/app.js',import.meta.url),'utf8'),file=ts.createSourceFile('app.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),missing=new Set<string>();
  function visit(n:ts.Node){if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateHead(n)||ts.isTemplateMiddle(n)||ts.isTemplateTail(n)){if(/[\u3400-\u9fff]/.test(panel.H(n.text)))missing.add(n.text);}ts.forEachChild(n,visit);}
  visit(file);const index=await readFile(new URL('../../public/index.html',import.meta.url),'utf8');const translated=panel.H(index).replaceAll('中文','');
  assert(!/[\u3400-\u9fff]/.test(translated),'index.html contains untranslated static text');
  assert.deepEqual([...missing],[],'app.js contains untranslated developer-owned text');
 }finally{panel.setLanguage('zh');}
});
