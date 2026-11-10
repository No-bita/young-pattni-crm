import { useEffect, useRef, useState } from "react";
import { api, fmtDate } from "../api.js";
import { Ava, Empty, ErrorBox, Loading, Pill, Strip, useAction, useApi } from "../components/ui.jsx";

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function Thread({ contactId, onSent }) {
  const { data, error, loading, reload } = useApi(`/inbox/${contactId}`, [contactId]);
  const [text, setText] = useState("");
  const action = useAction();
  const end = useRef(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [data]);
  useEffect(() => {
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [reload]);

  const send = (e) => {
    e.preventDefault();
    action.run(async () => {
      try {
        await api(`/inbox/${contactId}/reply`, { method: "POST", body: { text } });
        setText("");
      } finally {
        await reload();
        onSent();
      }
    });
  };

  if (loading && !data) return <div className="card"><Loading /></div>;
  if (error) return <div className="card"><ErrorBox error={error} onRetry={reload} /></div>;
  const { contact, messages } = data;
  const blocked = contact.suppressed ? "This contact opted out. Messages cannot be sent." : !contact.windowOpen ? "Replies are possible only within 24 hours of the contact's last message. Use a campaign with an approved template instead." : null;

  let lastDay = null;
  return (
    <>
      <div className="thread-head">
        <Ava name={contact.name} />
        <div className="grow">
          <b>{contact.name || contact.phone}</b>
          <div className="small mut mono">{contact.phone}</div>
        </div>
        {contact.suppressed && <Strip tone="r" dot={false}>Opted out</Strip>}
      </div>
      <div className="wa">
        <div className="msgs">
          {messages.length === 0 && <Empty>No messages yet.</Empty>}
          {messages.map((m) => {
            const dl = dayLabel(m.createdAt);
            const sep = dl !== lastDay ? <div className="day" key={`d-${m.id}`}>{dl}</div> : null;
            lastDay = dl;
            return (
              <div key={m.id} style={{ display: "contents" }}>
                {sep}
                <div className={`bub ${m.direction === "inbound" ? "in" : "out"}`}>
                  {m.body}
                  <div className="bmeta">
                    {m.direction === "outbound" && m.templateName && <span className="mono">{m.templateName} · </span>}
                    <span>{fmtDate(m.createdAt)}</span>
                    {m.direction === "outbound" && (m.status === "read"
                      ? <span className="ticks">✓✓</span>
                      : <span style={{ color: "#8696A0", fontSize: 12, letterSpacing: -2 }}>{m.status === "sent" ? "✓" : m.status === "delivered" ? "✓✓" : ""}</span>)}
                  </div>
                  {m.direction === "outbound" && (
                    <div className="bmeta" style={{ justifyContent: "flex-start" }}>
                      <Pill status={m.status} />
                      {m.replied && <span className="pill ok">Replied</span>}
                      <span>via {m.senderNumber || "unknown number"}</span>
                    </div>
                  )}
                  {m.status === "failed" && m.error && <div className="small" style={{ color: "var(--red)", marginTop: 4 }}>Not sent: {m.error}</div>}
                </div>
              </div>
            );
          })}
          <div ref={end} />
        </div>
      </div>
      <ErrorBox error={action.error} />
      {blocked ? <div className="alert warn" style={{ marginTop: 12, marginBottom: 0 }}>{blocked}</div> : (
        <form className="replybar" onSubmit={send}>
          <textarea className="grow" rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply" />
          <button className="sendbtn" aria-label="Send" disabled={action.busy || !text.trim()}>{action.busy ? "…" : "➤"}</button>
        </form>
      )}
    </>
  );
}

export default function Inbox({ contactId }) {
  const { data, error, loading, reload } = useApi("/inbox");

  if (contactId) {
    return (
      <>
        <div className="head">
          <div className="grow">
            <a href="#/inbox" className="mut small backlink">← Inbox</a>
            <h1>Conversation</h1>
          </div>
        </div>
        <Thread contactId={contactId} onSent={reload} />
      </>
    );
  }

  return (
    <>
      <div className="head"><h1>Inbox</h1></div>
      <div className="sub">Replies from your contacts land here</div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && data.conversations.length === 0 ? (
        <div className="card"><Empty>No conversations yet. Messages you send and replies you receive appear here.</Empty></div>
      ) : data && (
        <div className="card" style={{ padding: "6px 16px" }}>
          {data.conversations.map((c) => (
            <a key={c.contactId} href={`#/inbox/${c.contactId}`} className="crow" style={{ textDecoration: "none", color: "inherit" }}>
              <Ava name={c.name} />
              <div className="grow">
                <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
                  <b className="grow" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name || c.phone}</b>
                  <span className="mut small" style={{ flex: "none" }}>{fmtDate(c.lastMessageAt)}</span>
                </div>
                <div className="mut small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.lastDirection === "outbound" ? "You: " : ""}{c.lastBody}
                </div>
              </div>
              <span className="row" style={{ gap: 6, flex: "none" }}>
                {c.lastDirection === "outbound" && <Pill status={c.lastStatus} />}
                {c.lastDirection === "inbound" && <span className="pill ok">Replied</span>}
                {c.suppressed && <span className="pill bad">Opted out</span>}
              </span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
