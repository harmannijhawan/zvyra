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
})
