// Dev helper: inspect the test database. Usage: node scripts/inspect-db.mjs <sql>
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const db = new DatabaseSync(path.resolve(import.meta.dirname, '..', '.swarm-test', 'userdata', 'swarm.db'), { readOnly: true });
const rows = db.prepare(process.argv[2]).all();
for (const r of rows) console.log(JSON.stringify(r).slice(0, 700));
