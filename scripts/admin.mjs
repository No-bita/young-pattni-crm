#!/usr/bin/env node
// Springboard operator script. Runs on YOUR machine with YOUR Cloudflare login (via wrangler).
// It adds nothing to the live app: there is no account-creation or reset route on the server.
//
//   npm run admin -- create-account --name "Acme Traders" --login acme@example.com [--admin] [--local]
//   npm run admin -- reset-password --login acme@example.com [--local]     (ends all existing logins)
//   npm run admin -- set-admin --login you@example.com --on|--off [--local]
//   npm run admin -- unsuppress --login acme@example.com --phone +919876543210 [--local]
//   npm run admin -- list-accounts [--local]
//
// Passwords are typed at a hidden prompt, never passed as arguments or written to files.
// Without --local the command runs against the REMOTE (production) D1 database.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/lib/password.js";
import { normalizePhone } from "../src/lib/phone.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function sqlString(v) {
  if (v === null || v === undefined) return "NULL";
  const s = String(v);
  if (s.includes("\u0000")) throw new Error("Invalid character in input.");
  return `'${s.replace(/'/g, "''")}'`;
}

function databaseName() {
  const toml = readFileSync(join(root, "wrangler.toml"), "utf8");
  const m = /database_name\s*=\s*"([^"]+)"/.exec(toml);
  if (!m || m[1].startsWith("REPLACE_")) {
    throw new Error("Fill in database_name in wrangler.toml first (it still has the placeholder).");
  }
  return m[1];
}

function d1(sql, { local }) {
  const args = ["wrangler", "d1", "execute", databaseName(), local ? "--local" : "--remote", "--json", "--command", sql];
  const res = spawnSync("npx", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (res.status !== 0) {
    const out = `${res.stdout}\n${res.stderr}`;
    if (out.includes("UNIQUE constraint failed: accounts.login")) throw new Error("An account with this login already exists.");
    throw new Error(`wrangler failed:\n${out}`);
  }
  const parsed = extractJson(res.stdout);
  const results = Array.isArray(parsed) ? parsed : [parsed];
  return results.map((r) => r.results || []);
}

// wrangler can print notices (e.g. about proxy settings) before its JSON output.
export function extractJson(stdout) {
  const lines = String(stdout).split("\n");
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l));
  if (start === -1) throw new Error(`Unexpected wrangler output:\n${stdout}`);
  return JSON.parse(lines.slice(start).join("\n"));
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = function write(s) {
      if (s.startsWith(question)) rl.output.write(question);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function newPassword() {
  const p1 = await promptHidden("New password: ");
  if (p1.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const p2 = await promptHidden("Repeat password: ");
  if (p1 !== p2) throw new Error("Passwords do not match.");
  return hashPassword(p1);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return { command, opts };
}

function requireLogin(opts) {
  const login = String(opts.login || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+@-]{3,254}$/.test(login)) throw new Error("--login is required (letters, digits, . _ % + @ -).");
  return login;
}

function findAccount(login, local) {
  const [rows] = d1(`SELECT id, name, login, is_admin FROM accounts WHERE login = ${sqlString(login)}`, { local });
  if (!rows.length) throw new Error(`No account with login ${login}.`);
  return rows[0];
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const local = Boolean(opts.local);
  console.log(`Target database: ${local ? "LOCAL" : "REMOTE (production)"}`);

  switch (command) {
    case "create-account": {
      const login = requireLogin(opts);
      const name = String(opts.name || "").trim();
      if (!name || name.length > 120) throw new Error("--name is required (max 120 characters).");
      const hash = await newPassword();
      const id = `acc_${crypto.randomUUID().replace(/-/g, "")}`;
      d1(`INSERT INTO accounts (id, name, login, password_hash, is_admin) VALUES (${sqlString(id)}, ${sqlString(name)}, ${sqlString(login)}, ${sqlString(hash)}, ${opts.admin ? 1 : 0})`, { local });
      console.log(`Created account ${name} (${login})${opts.admin ? " as admin" : ""}.`);
      break;
    }
    case "reset-password": {
      const acc = findAccount(requireLogin(opts), local);
      const hash = await newPassword();
      const now = new Date().toISOString();
      d1(`UPDATE accounts SET password_hash = ${sqlString(hash)} WHERE id = ${sqlString(acc.id)}; UPDATE sessions SET revoked_at = ${sqlString(now)} WHERE account_id = ${sqlString(acc.id)} AND revoked_at IS NULL`, { local });
      console.log(`Password reset for ${acc.login}. All existing logins for this account have been ended.`);
      break;
    }
    case "set-admin": {
      const acc = findAccount(requireLogin(opts), local);
      if (Boolean(opts.on) === Boolean(opts.off)) throw new Error("Pass exactly one of --on or --off.");
      d1(`UPDATE accounts SET is_admin = ${opts.on ? 1 : 0} WHERE id = ${sqlString(acc.id)}`, { local });
      console.log(`${acc.login} is ${opts.on ? "now" : "no longer"} an admin.`);
      break;
    }
    case "unsuppress": {
      const acc = findAccount(requireLogin(opts), local);
      const phone = normalizePhone(opts.phone);
      const [rows] = d1(`SELECT id, suppressed FROM contacts WHERE account_id = ${sqlString(acc.id)} AND phone_e164 = ${sqlString(phone)}`, { local });
      if (!rows.length) throw new Error(`No contact +${phone} in ${acc.login}.`);
      if (!rows[0].suppressed) {
        console.log(`+${phone} is not suppressed.`);
        break;
      }
      d1(`UPDATE contacts SET suppressed = 0, suppressed_at = NULL, suppressed_source = NULL, updated_at = ${sqlString(new Date().toISOString())} WHERE id = ${sqlString(rows[0].id)} AND account_id = ${sqlString(acc.id)}`, { local });
      console.log(`Suppression lifted for +${phone} in ${acc.login}.`);
      break;
    }
    case "list-accounts": {
      const [rows] = d1("SELECT name, login, is_admin, created_at FROM accounts ORDER BY created_at", { local });
      console.table(rows);
      break;
    }
    default:
      console.log("Commands: create-account, reset-password, set-admin, unsuppress, list-accounts. See the top of scripts/admin.mjs.");
      process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
