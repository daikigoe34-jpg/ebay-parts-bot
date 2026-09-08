import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
// Execute the actual migration/SQL, adapting only D1's prepare/bind/first surface.
export function database() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0001_workspace.sql',import.meta.url),'utf8'));
  return {prepare(sql){let args=[];return {bind(...values){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args)||null;}};},close(){sqlite.close();}};
}
