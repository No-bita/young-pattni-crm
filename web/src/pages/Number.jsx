import { useState } from "react";
import { api, fmtDate } from "../api.js";
import { Empty, ErrorBox, Loading, Pill, useAction, useApi } from "../components/ui.jsx";

function AddSender({ onDone }) {
  const [tokenRef, setTokenRef] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const action = useAction();
  const submit = (e) => {
    e.preventDefault();
    action.run(async () => {
      await api("/senders", { method: "POST", body: { tokenRef, phoneNumberId, wabaId } });
      setTokenRef(""); setPhoneNumberId(""); setWabaId("");
      onDone();
    });
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Add a WhatsApp number</h2>
      <ErrorBox error={action.error} />
      <div className="mut small">Before this step, add the number's access token in Cloudflare as a Worker secret named WA_TOKEN_&lt;NAME&gt;. The new number stays inactive until it is tested and activated.</div>
      <label className="field"><span>Token secret name</span>
        <div className="row" style={{ flexWrap: "nowrap" }}><span className="mono">WA_TOKEN_</span><input className="grow" value={tokenRef} onChange={(e) => setTokenRef(e.target.value.toUpperCase())} placeholder="MAIN" required /></div>
      </label>
      <label className="field"><span>Phone number ID (from Meta)</span><input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value.trim())} required /></label>
      <label className="field"><span>WhatsApp Business Account ID</span><input value={wabaId} onChange={(e) => setWabaId(e.target.value.trim())} required /></label>
      <div><button disabled={action.busy}>Add number</button></div>
    </form>
  );
}

function TestPanel({ sender, onDone }) {
  const [testPhone, setTestPhone] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [result, setResult] = useState(null);
  const action = useAction();
  const tpls = useApi(`/senders/${sender.id}/test-templates`, [sender.testedAt]);

  const test = () => action.run(async () => {
    const res = await api(`/senders/${sender.id}/test`, { method: "POST", body: testPhone ? { testPhone, templateId } : {} });
    setResult(res);
    onDone();
  });

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div className="mut small">The test checks that the token can read this number, that the number belongs to the WhatsApp Business Account, and fetches its templates. You can also send one real test message.</div>
      <div className="row">
        <input placeholder="Optional: your phone for a test message" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
        {testPhone && (
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Template without variables</option>
            {(tpls.data?.templates || []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
          </select>
        )}
        <button className="secondary" disabled={action.busy || (testPhone && !templateId)} onClick={test}>{action.busy ? "Testing…" : "Run test"}</button>
      </div>
      {testPhone && tpls.data && tpls.data.templates.length === 0 && <div className="mut small">Run the test once without a phone to load this number's templates.</div>}
      <ErrorBox error={action.error} />
      {result && (result.ok ? <div className="alert ok">Test passed.</div> : <div className="alert bad">Test failed: {result.error}</div>)}
    </div>
  );
}

function Activate({ sender, onDone }) {
  const action = useAction();
  const activate = () => action.run(async () => {
    await api(`/senders/${sender.id}/activate`, { method: "POST" });
    onDone();
  });
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <ErrorBox error={action.error} />
      <div><button disabled={action.busy || !sender.testedAt} onClick={activate}>Activate this number</button></div>
      <div className="mut small">Activating makes this the only number that sends for your account. The current number is kept but stops sending. Switching is refused while a campaign is scheduled or sending, or if draft campaigns use templates that are not approved on this number.</div>
    </div>
  );
}

function Messages({ sender }) {
  const { data, error, loading } = useApi(`/senders/${sender.id}/messages`);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data.messages.length) return <Empty>No messages have used this number yet.</Empty>;
  return (
    <>
      <div className="mobile-records">
        {data.messages.map((m) => (
          <div key={m.id} className="record">
            <div className="record-head"><b>{m.contactName || m.contactPhone}</b><Pill status={m.status} /></div>
            <div className="small mut">{m.contactName && <span className="mono">{m.contactPhone} · </span>}{fmtDate(m.createdAt)} · {m.direction === "inbound" ? "Received" : "Sent"}</div>
            <div className="small record-body">{m.templateName ? <span className="mono">{m.templateName}</span> : m.body}</div>
            {m.error && <div className="small record-error">{m.error}</div>}
          </div>
        ))}
      </div>
    <div className="table-wrap desktop-records">
      <table>
        <thead><tr><th>When</th><th>Contact</th><th>Direction</th><th>Message</th><th>Status</th></tr></thead>
        <tbody>{data.messages.map((m) => (
          <tr key={m.id}>
            <td className="mut">{fmtDate(m.createdAt)}</td>
            <td>{m.contactName || m.contactPhone}</td>
            <td>{m.direction === "inbound" ? "Received" : "Sent"}</td>
            <td className="small" style={{ maxWidth: 320 }}>{m.templateName ? <span className="mono">{m.templateName}</span> : m.body}</td>
            <td><Pill status={m.status} />{m.error && <div className="small" style={{ color: "var(--red)" }}>{m.error}</div>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
    </>
  );
}

export default function NumberPage() {
  const { data, error, loading, reload } = useApi("/senders");
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const senders = data?.senders || [];
  const active = senders.find((s) => s.status === "active");

  return (
    <>
      <div className="head">
        <h1>WhatsApp number</h1>
        <button className="secondary" onClick={() => setAdding(!adding)}>Add a number</button>
      </div>
      <div className="sub">The number your campaigns and replies send from</div>
      <ErrorBox error={error} onRetry={reload} />
      {adding && <AddSender onDone={() => { setAdding(false); reload(); }} />}
      {loading && !data ? <Loading /> : (
        <>
          {!active && senders.length > 0 && <div className="alert warn">No number is active. Nothing can be sent until one is tested and activated.</div>}
          {senders.length === 0 && <div className="card"><Empty>No WhatsApp number yet. Add one to start sending.</Empty></div>}
          {senders.map((s) => (
            <div className="card" key={s.id}>
              <div className="row">
                <div className="grow">
                  <div><b>{s.displayNumber || "Number not verified yet"}</b> <Pill status={s.status} /> {s.verifiedName && <span className="mut">{s.verifiedName}</span>}</div>
                  <div className="mut small mono">phone id {s.phoneNumberId} · WABA {s.wabaId} · WA_TOKEN_{s.tokenRef}</div>
                  <div className="mut small">
                    {s.testedAt ? `Tested ${fmtDate(s.testedAt)}` : "Not tested"}
                    {s.activatedAt && ` · Activated ${fmtDate(s.activatedAt)}`}
                    {` · ${s.messagesSent} sent, ${s.messagesFailed} failed`}
                  </div>
                  {s.testError && <div className="small" style={{ color: "var(--red)" }}>Last test failed: {s.testError}</div>}
                </div>
                <button className="secondary" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Close" : s.status === "active" ? "Messages" : "Test, activate and messages"}</button>
              </div>
              {open === s.id && (
                <>
                  {s.status !== "active" && <TestPanel sender={s} onDone={reload} />}
                  {s.status === "inactive" && <Activate sender={s} onDone={reload} />}
                  <h2 style={{ marginTop: 16 }}>Messages that used this number</h2>
                  <Messages sender={s} />
                </>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}
