/** Evidence used by the runtime, independent of the model's completion prose. */
export class CompletionEvidence {
  private failures = new Map<string, string>()
  private sites = new Map<string, boolean>()
  private computerPending = false

  observe(tool: string, args: Record<string, unknown>, result: Record<string, unknown>) {
    const failed = result.ok === false || !!result.error
    if (tool === 'computer') {
      if (failed || args.action !== 'observe') this.computerPending = true
      if (!failed && result.verified === true) this.computerPending = false
    }
    const identity = String(args.save_to ?? args.dossier_path ?? args.target ?? '')
    const key = `${tool}:${identity}`
    if (['research_business', 'download_images', 'check_site'].includes(tool)) {
      if (failed) this.failures.set(key, String(result.error ?? (Array.isArray(result.issues) ? result.issues.join('; ') : `${tool} did not pass`)))
      else this.failures.delete(key)
    }
    if (['create_file', 'edit_file', 'build_business_site'].includes(tool) && !failed && typeof result.path === 'string' && /\.(html?|css|[jt]sx?)$/i.test(result.path)) {
      // Changes invalidate earlier checks. A new check must cover the affected site.
      for (const file of this.sites.keys()) this.sites.set(file, false)
      this.sites.set(result.path.replace(/\\/g, '/').toLowerCase(), false)
    }
    if (tool === 'check_site' && !failed) {
      const target = String(args.target ?? '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
      const root = /\.html?$/.test(target) ? target.slice(0, target.lastIndexOf('/')) : target
      for (const file of this.sites.keys()) if (file === target || file.startsWith(root + '/')) this.sites.set(file, true)
    }
  }

  issues() {
    const out = [...this.failures.values()]
    if (this.computerPending) out.push('Computer work has not passed an explicit visible postcondition after the latest action.')
    // Source code work isn't necessarily a website. HTML writes are a concrete signal.
    if ([...this.sites].some(([file, checked]) => /\.html?$/.test(file) && !checked)) out.push('Generated HTML has not passed a site check after the latest changes.')
    return out
  }
}
