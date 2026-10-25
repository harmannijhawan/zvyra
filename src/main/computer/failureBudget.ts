/** Observing successfully cannot erase a repeated input failure. */
export class ComputerFailureBudget {
  private failures=0
  private recoveries=0
  reset(){this.failures=0;this.recoveries=0}
  record(result:Record<string,unknown>):boolean {
    if(result.error||result.ok===false) {
      // A stale read or covered target is a replan, not a hardware failure.
      // Still bound it: observations alone cannot hide an endless retry loop.
      if(result.recoverable===true && result.inputExecuted!== 'unknown')this.recoveries++
      else this.failures++
    }
    else if(result.inputExecuted===true||result.verified===true)this.reset()
    return this.failures>=3||this.recoveries>=8
  }
}
