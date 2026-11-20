// Summary counts only. Recipient delivery states and reasons stay unchanged.
export function campaignSummary(recipients = {}) {
  const total = Object.values(recipients).reduce((sum, count) => sum + count, 0);
  const delivered = recipients.delivered || 0;
  const read = recipients.read || 0;
  const failed = (recipients.failed || 0) + (recipients.skipped_suppressed || 0) + (recipients.cancelled || 0);
  return { total, delivered, read, failed, awaiting: total - delivered - read - failed };
}
