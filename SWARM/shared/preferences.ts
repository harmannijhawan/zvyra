// Portable account preferences. Credentials, executable paths and permissions are never accepted here.
export type Preferences = {ai?:{routing?:string;freeMode?:boolean;pinnedModel?:string|null;temperature?:number;maxOutputTokens?:number};routing?:{maxFallbacks?:number;excluded?:string[]};agents?:{modelPreference?:Record<string,string|null>};providers?:{enabled?:Record<string,boolean>};appearance?:{theme?:string;accent?:string;density?:string;animations?:boolean;reducedMotion?:string;fontScale?:number}};
export function validatePreferences(input:unknown):Preferences {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid preferences.');
  const value=input as Record<string,any>;const result:Record<string,any>={};
  const choices:Record<string,string[]>={'ai.routing':['auto','local_first','cloud_first','fastest','quality'],'appearance.theme':['light','dark','system'],'appearance.accent':['graphite','blue','violet','green','amber','rose'],'appearance.density':['compact','comfortable','spacious'],'appearance.reducedMotion':['system','on','off']};
  const numbers:Record<string,number[]>={'ai.temperature':[0,1.5],'ai.maxOutputTokens':[512,32768],'routing.maxFallbacks':[0,12],'appearance.fontScale':[.85,1.25]};
  const fields:Record<string,string[]>={ai:['routing','freeMode','pinnedModel','temperature','maxOutputTokens'],routing:['maxFallbacks','excluded'],agents:['modelPreference'],providers:['enabled'],appearance:['theme','accent','density','animations','reducedMotion','fontScale']};
  for(const [section,part] of Object.entries(value)){
    if(!fields[section]||!part||typeof part!=='object'||Array.isArray(part))throw new Error('Unsupported preference section.');
    result[section]={};
    for(const [key,v] of Object.entries(part)){
      if(!fields[section].includes(key))throw new Error('Unsupported preference.');
      const path=section+'.'+key;let valid=false;
      if(choices[path])valid=typeof v==='string'&&choices[path].includes(v);
      else if(numbers[path])valid=typeof v==='number'&&Number.isFinite(v)&&v>=numbers[path][0]&&v<=numbers[path][1]&&(!['maxFallbacks','maxOutputTokens'].includes(key)||Number.isInteger(v));
      else if(key==='freeMode'||key==='animations')valid=typeof v==='boolean';
      else if(key==='pinnedModel')valid=v===null||(typeof v==='string'&&v.length<=200);
      else if(key==='excluded')valid=Array.isArray(v)&&v.length<=500&&v.every(x=>typeof x==='string'&&x.length<=200);
      else if(key==='enabled'||key==='modelPreference')valid=!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.entries(v).length<=100&&Object.entries(v).every(([k,x])=>/^[a-z0-9_-]{1,50}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k)&&(key==='enabled'?typeof x==='boolean':x===null||typeof x==='string'&&x.length<=200));
      if(!valid)throw new Error('Invalid '+path+'.');result[section][key]=v;
    }
  }
  return result;
}
