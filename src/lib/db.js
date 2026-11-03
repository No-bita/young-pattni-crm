// Thin helpers over the D1 binding. All SQL uses bound parameters.

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function one(db, sql, ...args) {
  return (await db.prepare(sql).bind(...args).first()) ?? null;
}

export async function all(db, sql, ...args) {
  const res = await db.prepare(sql).bind(...args).all();
  return res.results ?? [];
}

export async function run(db, sql, ...args) {
  const res = await db.prepare(sql).bind(...args).run();
  return res.meta?.changes ?? 0;
}

export function stmt(db, sql, ...args) {
  return db.prepare(sql).bind(...args);
}
