import { pageInfo } from "../lib/pagination.js";
export default function ListPagination({ total, page, onPage, noun, busy = false }) {
  const info = pageInfo(total, page);
  return <nav className="row" aria-label={`${noun} pagination`}>
    <span className="small mut grow">{info.start}–{info.end} of {total} {noun} · Page {info.page + 1} of {info.pages}</span>
    <button className="secondary" disabled={busy || info.page === 0} onClick={() => onPage(info.page - 1)}>Previous</button>
    <button className="secondary" disabled={busy || info.page + 1 >= info.pages} onClick={() => onPage(info.page + 1)}>Next</button>
  </nav>;
}
