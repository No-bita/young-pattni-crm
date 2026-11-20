import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Loading } from "./components/ui.jsx";
import { SendIcon, PeopleIcon, ChatIcon } from "./components/icons.jsx";
import Login from "./pages/Login.jsx";
import Contacts from "./pages/Contacts.jsx";
import Campaigns from "./pages/Campaigns.jsx";
import CampaignNew from "./pages/CampaignNew.jsx";
import CampaignDetail from "./pages/CampaignDetail.jsx";
import Inbox from "./pages/Inbox.jsx";
import NumberPage from "./pages/Number.jsx";
import Admin from "./pages/Admin.jsx";

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || "#/campaigns");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/campaigns");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "").split("/").filter(Boolean);
}

function AccountMenu({ account, active }) {
  const menu = useRef(null);
  useEffect(() => {
    const closeOutside = (e) => { if (menu.current && !menu.current.contains(e.target)) menu.current.open = false; };
    const closeEscape = (e) => { if (e.key === "Escape" && menu.current?.open) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, []);
  return <details className="account-menu" ref={menu}>
    <summary title={account.name}>{account.name}<span aria-hidden="true">▾</span></summary>
    <nav aria-label="Account navigation" className="account-menu-links" onClick={() => { menu.current.open = false; }}>
      <a href="#/number" aria-current={active === "number" ? "page" : undefined}>Number</a>
      {account.isAdmin && <a href="#/admin" aria-current={active === "admin" ? "page" : undefined}>Admin</a>}
    </nav>
  </details>;
}

export default function App() {
  const [me, setMe] = useState(undefined);
  const parts = useHashRoute();

  const loadMe = () => api("/auth/me").then((d) => setMe(d.account)).catch(() => setMe(null));
  useEffect(() => {
    loadMe();
    const out = () => setMe(null);
    window.addEventListener("sb:signed-out", out);
    return () => window.removeEventListener("sb:signed-out", out);
  }, []);

  if (me === undefined) return <Loading />;
  if (!me) return <Login onSignedIn={loadMe} />;

  const [section, id, sub] = parts;
  let page;
  if (section === "contacts") page = <Contacts />;
  else if (section === "campaigns" && id === "new") page = <CampaignNew />;
  else if (section === "campaigns" && id) page = <CampaignDetail id={id} step={sub} />;
  else if (section === "inbox") page = <Inbox contactId={id} />;
  else if (section === "number") page = <NumberPage />;
  else if (section === "admin" && me.isAdmin) page = <Admin />;
  else page = <Campaigns />;

  const nav = [
    ["campaigns", "Campaigns", <SendIcon key="i" />],
    ["contacts", "Contacts", <PeopleIcon key="i" />],
    ["inbox", "Inbox", <ChatIcon key="i" />],
  ];

  const signOut = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
  };

  const active = section || "campaigns";
  return (
    <>
      <header className="desktop-header">
        <div className="desktop-header-inner">
          <a href="#/campaigns" className="disp app-brand">PJM Youth CRM</a>
          <nav className="topnav" aria-label="Main navigation">
            {nav.map(([key, label]) => <a key={key} href={`#/${key}`} className={active === key ? "on" : ""} aria-current={active === key ? "page" : undefined}>{label}</a>)}
          </nav>
          <div className="account-actions">
            <AccountMenu account={me} active={active} />
            <button className="secondary" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </header>
      <div className="shell">
        <div className="row mobile-header" style={{ marginBottom: 10 }}>
          <span className="disp grow" style={{ fontSize: 15, fontWeight: 700 }}>PJM Youth CRM</span>
          <AccountMenu account={me} active={active} />
          <button className="secondary" style={{ padding: "6px 12px", fontSize: 13 }} onClick={signOut}>Sign out</button>
        </div>
        {page}
      </div>
      <nav className="pillnav" aria-label="Mobile navigation">
        {nav.map(([key, label, icon]) => (
          <a key={key} href={`#/${key}`} className={active === key ? "on" : ""}>{icon}{label}</a>
        ))}
      </nav>
    </>
  );
}
