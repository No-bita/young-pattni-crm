import { useState } from "react";
import { api } from "../api.js";
import { ErrorBox, useAction } from "../components/ui.jsx";

// Sign-in only. There is no signup: accounts are created by the Springboard operator.
export default function Login({ onSignedIn }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      await api("/auth/login", { method: "POST", body: { login, password } });
      onSignedIn();
    });
  };

  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <h1>Sign in to Springboard</h1>
        <ErrorBox error={error} />
        <label className="field">
          <span>Login</span>
          <input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button disabled={busy || !login || !password}>{busy ? "Signing in…" : "Sign in"}</button>
        <div className="muted small">Forgot your password? Contact your Springboard operator.</div>
      </form>
    </div>
  );
}
