import { useEffect, useRef, useState } from "react";
import { api, fmtDate } from "../api.js";
import { Empty, ErrorBox, Loading, Pill, useAction, useApi } from "../components/ui.jsx";

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

  return (
    <div className="card thread">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow"><b>{contact.name || contact.phone}</b> <span className="muted mono">{contact.phone}</span></div>
        {contact.suppressed && <span className="pill bad">Opted out</span>}
      </div>
      <div className="msgs">
        {messages.length === 0 && <Empty>No messages yet.</Empty>}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.direction === "inbound" ? "in" : "out"}`}>
            {m.body}
            <div className="meta">
              <span>{fmtDate(m.createdAt)}</span>
              {m.direction === "outbound" && <Pill status={m.status} />}
              {m.replied && <span className="pill ok">Replied</span>}
              {m.direction === "outbound" && m.templateName && <span className="mono">{m.templateName}</span>}
              <span>via {m.senderNumber || "unknown number"}</span>
            </div>
            {m.status === "failed" && m.error && <div className="small" style={{ color: "var(--bad)", marginTop: 4 }}>Not sent: {m.error}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <ErrorBox error={action.error} />
      {blocked ? <div className="alert warn" style={{ marginBottom: 0 }}>{blocked}</div> : (
        <form className="row" onSubmit={send}>
          <textarea className="grow" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply" />
          <button disabled={action.busy || !text.trim()}>{action.busy ? "Sending…" : "Send"}</button>
        </form>
      )}
    </div>
  );
}

export default function Inbox({ contactId }) {
  const { data, error, loading, reload } = useApi("/inbox");
  return (
    <>
      <div className="head"><h1>Inbox</h1></div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && data.conversations.length === 0 ? (
        <div className="card"><Empty>No conversations yet. Messages you send and replies you receive appear here.</Empty></div>
      ) : data && (
        <div className="inbox">
          <div className="card convs">
            {data.conversations.map((c) => (
              <a key={c.contactId} href={`#/inbox/${c.contactId}`} className={`conv ${c.contactId === contactId ? "on" : ""}`}>
                <div className="row"><b className="grow">{c.name || c.phone}</b><span className="muted small">{fmtDate(c.lastMessageAt)}</span></div>
                <div className="muted small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.lastDirection === "outbound" ? "You: " : ""}{c.lastBody}
                </div>
                <div className="row" style={{ marginTop: 4 }}>
                  {c.lastDirection === "outbound" && <Pill status={c.lastStatus} />}
                  {c.lastDirection === "inbound" && <span className="pill ok">Replied</span>}
                  {c.suppressed && <span className="pill bad">Opted out</span>}
                </div>
              </a>
            ))}
          </div>
          {contactId ? <Thread contactId={contactId} onSent={reload} /> : <div className="card"><Empty>Select a conversation.</Empty></div>}
        </div>
      )}
    </>
  );
}
