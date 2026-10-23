/** Observing successfully cannot erase a repeated input failure. */
export class ComputerFailureBudget {
  private failures=0
  reset(){this.failures=0}
  record(result:Record<string,unknown>):boolean {
    if(result.error||result.ok===false)this.failures++
    else if(result.inputExecuted===true||result.verified===true)this.failures=0
    return this.failures>=3
  }
}
