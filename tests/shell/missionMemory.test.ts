import {describe,it,expect} from 'vitest'
import type {Content} from '@google/genai'
import {MissionMemory} from '../../src/main/agent/missionMemory'

describe('long mission working memory',()=>{
  it('preserves the original request, notes, pending work and intact recent tool pairs',()=>{
    const m=new MissionMemory(),request:Content={role:'user',parts:[{text:'Complete the requested workflow'}]}
    m.setPlan([{title:'Inspect',status:'done'},{title:'Verify result',status:'running'}])
    m.save({findings:['The source page showed 14 items at https://example.test/items'],completed:['Inspected first 8'],remaining:['Inspect last 6'],next_action:'Continue from item 9'})
    const contents:Content[]=[request]
    for(let i=0;i<20;i++) {
      contents.push({role:'model',parts:[{functionCall:{name:'computer',id:String(i),args:{action:'observe'}},thoughtSignature:`sig${i}`}]},{role:'user',parts:[{functionResponse:{name:'computer',id:String(i),response:{frame:`f${i}`}}}]})
      m.record('computer',{action:'observe'},{ok:true,frame:`f${i}`,description:'Visible source'})
    }
    expect(m.compact(contents,request)).toBe(true)
    expect(contents).toHaveLength(8);expect(contents[0]).toBe(request)
    expect(contents[1].parts?.[0].text).toContain('Inspect last 6')
    expect(contents[2].parts?.[0].functionCall?.id).toBe('17')
    expect(contents[2].parts?.[0].thoughtSignature).toBe('sig17')
    expect(contents[3].parts?.[0].functionResponse?.id).toBe('17')
    expect(m.pending()).toEqual(['Verify result'])
  })
  it('bounds stored data and does not store screen images or raw page bodies',()=>{
    const m=new MissionMemory()
    expect(()=>m.save({findings:Array(41).fill('x')})).toThrow()
    for(let i=0;i<150;i++)m.record('computer',{action:'observe'},{frame:`f${i}`,image:'secret-base64',body:'large-page-body'})
    expect(m.summary()).not.toContain('secret-base64');expect(m.summary()).not.toContain('large-page-body')
    expect(JSON.parse(m.summary()).recentToolReceipts).toHaveLength(60)
  })
})
