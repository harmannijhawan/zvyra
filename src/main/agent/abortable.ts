/** Bound SDK work even if its transport fails to honor AbortSignal promptly. */
export function abortable<T>(work:()=>Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new Error('Cancelled'))
    signal.addEventListener('abort',abort,{once:true})
    Promise.resolve().then(()=>{signal.throwIfAborted();return work()}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))
  })
}
