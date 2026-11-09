import React from 'react';
import {createRoot} from 'react-dom/client';
import Home from '../app/page';
import '../app/globals.css';
import '../app/homebase.css';

/** Keeps one bad reading from blanking the whole dashboard; the next poll usually recovers. */
class Boundary extends React.Component<{children: React.ReactNode}, {error: Error | null; key: number}> {
  state = {error: null as Error | null, key: 0};
  static getDerivedStateFromError(error: Error) { return {error}; }
  componentDidCatch(error: Error) { console.error('[Homebase]', error); }
  render() {
    if (!this.state.error) return <React.Fragment key={this.state.key}>{this.props.children}</React.Fragment>;
    return (
      <div className="crash">
        <div>
          <strong>Something went wrong drawing the dashboard</strong>
          <p>Your server is unaffected. This is a display error: {this.state.error.message}</p>
          <button className="button primary" onClick={() => this.setState(s => ({error: null, key: s.key + 1}))}>Reload dashboard</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Boundary><Home /></Boundary></React.StrictMode>);
