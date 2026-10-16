import { AlertTriangle } from 'lucide-react'
import { Component, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/** Keeps a crashing screen from taking down the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`[ui] ${this.props.label ?? 'view'} crashed:`, error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page">
        <div className="notice danger" role="alert">
          <AlertTriangle />
          <div style={{ flex: 1 }}>
            <b>This screen hit an error.</b>
            <div className="selectable mono" style={{ marginTop: 4 }}>
              {this.state.error.message}
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    )
  }
}
