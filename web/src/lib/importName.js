// Date only. Duplicate batch names are allowed; the import ID remains unique.
export function defaultImportName(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  }).format(date);
}
