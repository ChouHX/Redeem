// 导入吞吐基准：13w 行文本解析 + 入库耗时。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = path.join(os.tmpdir(), "redeem-import-bench");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.DB_PATH = path.join(dir, "import.db");

const db = await import("../src/db.js");
const { parseInventoryImportText } = await import("../src/redeem.js");

const ROWS = Number(process.env.BENCH_ROWS || 130000);
const type = db.ensureDefaultRedeemEmailType();

const lines = [];
for (let i = 1; i <= ROWS; i += 1) {
  lines.push(
    `bench${i}@outlook.com----pw-${i}----dbc8e03a-b00c-46bd-ae65-b683e7707cb0----rt-${i}-${"x".repeat(40)}`,
  );
}
const text = lines.join("\n");

let start = Date.now();
const parsed = parseInventoryImportText({
  text,
  field_schema: type.field_schema,
  import_delimiter: type.import_delimiter,
});
console.log(`解析 ${ROWS} 行: ${Date.now() - start}ms（成功 ${parsed.items.length}）`);

start = Date.now();
const result = db.importRedeemInventory({
  type_id: type.id,
  items: parsed.items,
  mail_protocols: type.mail_protocols,
});
console.log(`入库 ${ROWS} 行: ${Date.now() - start}ms`, result);

const flags = db.db
  .prepare(
    `SELECT COUNT(*) AS total,
            SUM(pickup_imap) AS imap,
            SUM(pickup_graph) AS graph,
            SUM(CASE WHEN pickup_imap <> (instr(pickup_protocols, '"imap"') > 0) THEN 1 ELSE 0 END) AS mismatch
     FROM redeem_inventory`,
  )
  .get();
console.log("标志列核对:", flags);
process.exit(0);
