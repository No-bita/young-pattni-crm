import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Loading } from "./components/ui.jsx";
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

  const nav = [["campaigns", "Campaigns"], ["contacts", "Contacts"], ["inbox", "Inbox"], ["number", "WhatsApp number"]];
  if (me.isAdmin) nav.push(["admin", "Admin"]);

  const signOut = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
  };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Springboard</div>
        <nav className="nav">
          {nav.map(([key, label]) => (
            <a key={key} href={`#/${key}`} className={(section || "campaigns") === key ? "on" : ""}>{label}</a>
          ))}
        </nav>
        <div className="foot">
          <div>{me.name}</div>
          <button className="secondary" style={{ marginTop: 8 }} onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="main">{page}</main>
    </div>
  );
}
