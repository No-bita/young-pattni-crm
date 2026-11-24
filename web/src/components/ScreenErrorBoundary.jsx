import { Component } from "react";

// Keep recovery independent of the screen that failed, including App itself.
export default class ScreenErrorBoundary extends Component {
  state = { failed: false };
  currentRoute = window.location.hash || "#/campaigns";
  previousRoute = null;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidMount() {
    window.addEventListener("hashchange", this.onRouteChange);
  }

  componentWillUnmount() {
    window.removeEventListener("hashchange", this.onRouteChange);
  }

  onRouteChange = () => {
    const next = window.location.hash || "#/campaigns";
    if (next !== this.currentRoute) {
      this.previousRoute = this.currentRoute;
      this.currentRoute = next;
    }
    if (this.state.failed) this.setState({ failed: false });
  };

  back = () => {
    // Hash-only navigation never sends someone back to another website. Direct links
    // have no in-app history, so a conversation goes to Inbox and other screens to Home.
    const fallback = this.currentRoute.startsWith("#/inbox/") ? "#/inbox" : "#/campaigns";
    const target = this.previousRoute && this.previousRoute !== this.currentRoute ? this.previousRoute : fallback;
    if (window.location.hash === target) this.setState({ failed: false });
    else window.location.hash = target;
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="shell" style={{ paddingTop: 32 }}>
        <section className="card stack" role="alert" aria-labelledby="screen-error-title" style={{ maxWidth: 560, margin: "0 auto" }}>
          <h1 id="screen-error-title">Something went wrong</h1>
          <p>This screen could not be shown. Go back to the previous screen or reload to try again.</p>
          <div className="row">
            <button type="button" className="secondary" onClick={this.back}>Back</button>
            <button type="button" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </section>
      </main>
    );
  }
}
