import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Loading } from "./components/ui.jsx";
import { SendIcon, PeopleIcon, ChatIcon, PhoneIcon, ShieldIcon } from "./components/icons.jsx";
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

  const nav = [
    ["campaigns", "Campaigns", <SendIcon key="i" />],
    ["contacts", "Contacts", <PeopleIcon key="i" />],
    ["inbox", "Inbox", <ChatIcon key="i" />],
    ["number", "Number", <PhoneIcon key="i" />],
  ];
  if (me.isAdmin) nav.push(["admin", "Admin", <ShieldIcon key="i" />]);

  const signOut = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
  };

  const active = section || "campaigns";
  return (
    <>
      <div className="shell">
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="disp grow" style={{ fontSize: 15, fontWeight: 700 }}>PJM Youth CRM</span>
          <span className="small mut">{me.name}</span>
          <button className="secondary" style={{ padding: "6px 12px", fontSize: 13 }} onClick={signOut}>Sign out</button>
        </div>
        {page}
      </div>
      <nav className="pillnav">
        {nav.map(([key, label, icon]) => (
          <a key={key} href={`#/${key}`} className={active === key ? "on" : ""}>{icon}{label}</a>
        ))}
      </nav>
    </>
  );
}
