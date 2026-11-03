// Phone numbers are stored as E.164 digits without '+', e.g. 919876543210.
// Input without a country code is treated as India (+91), per the v1 decision.

export class PhoneError extends Error {}

export function normalizePhone(raw, defaultCountryCode = "91") {
  if (raw === null || raw === undefined) throw new PhoneError("Phone number is required.");
  const str = String(raw).trim();
  if (!str) throw new PhoneError("Phone number is required.");
  if (!/^[+\d\s\-().]+$/.test(str)) throw new PhoneError("Phone number contains invalid characters.");

  let digits = str.replace(/\D/g, "");
  if (str.startsWith("+")) {
    // already has a country code
  } else if (str.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.length === 10) {
    digits = defaultCountryCode + digits;
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = defaultCountryCode + digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    // Indian number written with country code but no '+'
  } else {
    throw new PhoneError("Add the country code, e.g. +44 7700 900123.");
  }

  // E.164: up to 15 digits; shortest real numbers with country code are ~8 digits.
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) {
    throw new PhoneError("Phone number is not a valid international number.");
  }
  if (digits.startsWith("91") && digits.length !== 12) {
    throw new PhoneError("Indian mobile numbers have 10 digits after +91.");
  }
  return digits;
}

export function formatPhone(e164) {
  return e164 ? `+${e164}` : "";
}
