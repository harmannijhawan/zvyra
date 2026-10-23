import {describe,it,expect} from 'vitest'
import {abortable} from '../../src/main/agent/abortable'
describe('desktop inference cancellation',()=>{
  it('unblocks cancellation even when an SDK transport never settles',async()=>{
    const controller=new AbortController()
    const request=abortable(()=>new Promise<never>(()=>{}),controller.signal)
    const outcome=expect(request).rejects.toThrow('Emergency stop')
    controller.abort(new Error('Emergency stop'));await outcome
  })
  it('does not start work cancelled while queued',async()=>{
    const controller=new AbortController();let started=false
    const request=abortable(async()=>{started=true;return 1},controller.signal)
    const outcome=expect(request).rejects.toThrow('Cancelled')
    controller.abort(new Error('Cancelled'));await outcome;expect(started).toBe(false)
  })
})
