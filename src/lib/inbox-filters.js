export const INBOX_FILTERS = ["all", "replied", "sent", "delivered", "read", "failed", "opted_out"];
export function conversationMatches(row, filter) {
  if (filter === "all") return true;
  if (filter === "opted_out") return Boolean(row.suppressed);
  if (filter === "replied") return row.last_direction === "inbound";
  return row.last_direction === "outbound" && row.last_status === filter;
}
