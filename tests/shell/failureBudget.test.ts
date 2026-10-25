import {describe,it,expect} from 'vitest'
import {ComputerFailureBudget} from '../../src/main/computer/failureBudget'
describe('repeated desktop failure cutoff',()=>{
  it('stops failed clicks even when fresh observations succeed between them',()=>{
    const b=new ComputerFailureBudget()
    expect(b.record({error:'stale'})).toBe(false);expect(b.record({ok:true})).toBe(false)
    expect(b.record({error:'stale'})).toBe(false);expect(b.record({ok:true})).toBe(false)
    expect(b.record({error:'stale'})).toBe(true)
  })
  it('allows recovery after actual input succeeds and resets for a new conversation',()=>{
    const b=new ComputerFailureBudget()
    b.record({ok:false});b.record({ok:false});expect(b.record({inputExecuted:true})).toBe(false)
    expect(b.record({ok:false})).toBe(false);expect(b.record({ok:false})).toBe(false);expect(b.record({ok:false})).toBe(true)
    b.reset();expect(b.record({error:'once'})).toBe(false)
  })
  it('allows bounded replanning without treating stale observations as three failed inputs',()=>{
    const b=new ComputerFailureBudget()
    for(let i=0;i<7;i++) {
      expect(b.record({ok:false,recoverable:true,inputExecuted:false})).toBe(false)
      expect(b.record({ok:true,frame:`f${i}`})).toBe(false)
    }
    expect(b.record({ok:false,recoverable:true,inputExecuted:false})).toBe(true)
    b.reset();b.record({ok:false,recoverable:true,inputExecuted:false});b.record({ok:true,inputExecuted:true})
    expect(b.record({ok:false,recoverable:true,inputExecuted:false})).toBe(false)
  })
})
