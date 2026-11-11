import { useState } from "react";
import { api } from "../api.js";
import { ErrorBox, useAction } from "../components/ui.jsx";
import { ChatIcon } from "../components/icons.jsx";

// Sign-in only. There is no signup: accounts are created by the PJM Youth CRM operator.
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
      <div className="inner">
        <div className="brandmark">
          <ChatIcon />
          <h1>PJM Youth CRM</h1>
        </div>
        <form className="card stack" onSubmit={submit}>
          <ErrorBox error={error} />
          <label className="field">
            <span>Login</span>
            <input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button className="block" disabled={busy || !login || !password}>{busy ? "Signing in…" : "Sign in"}</button>
          <div className="mut small" style={{ textAlign: "center" }}>Forgot your password? Ask your PJM operator</div>
        </form>
      </div>
    </div>
  );
}
