// 分页正确性核对：新分页 SQL 与参考实现逐页比对。
import path from "node:path";
import os from "node:os";

process.env.DB_PATH = process.env.VERIFY_DB || path.join(os.tmpdir(), "redeem-bench", "bench.db");
const db = await import("../src/db.js");

const cases = [
  { label: "无筛选", filters: {} },
  { label: "type_id", filters: { type_id: "1" } },
  { label: "status=available", filters: { status: "available" } },
  { label: "type+status", filters: { type_id: "1", status: "available" } },
  { label: "protocol=imap", filters: { protocol: "imap" } },
  { label: "type+status+protocol", filters: { type_id: "1", status: "available", protocol: "graph" } },
];

let failed = 0;
for (const { label, filters } of cases) {
  const pageSize = 50;
  const seen = new Set();
  for (const page of [1, 2, 5]) {
    const result = db.getRedeemInventoryPaged({ ...filters, page, page_size: pageSize });
    // 参考实现：同一组筛选条件用朴素 SQL 直接取该页。
    const whereParts = [];
    const params = [];
    if (filters.type_id) { whereParts.push("type_id = ?"); params.push(Number(filters.type_id)); }
    if (filters.status) { whereParts.push("status = ?"); params.push(filters.status); }
    if (filters.protocol) { whereParts.push(`pickup_${filters.protocol} = 1`); }
    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const reference = db.db
      .prepare(`SELECT id FROM redeem_inventory ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize)
      .map((row) => Number(row.id));
    const actual = result.items.map((item) => Number(item.id));

    if (JSON.stringify(actual) !== JSON.stringify(reference)) {
      failed += 1;
      console.log(`  MISMATCH ${label} page=${page}`);
      console.log(`    expected=${reference.slice(0, 5)}...`);
      console.log(`    actual  =${actual.slice(0, 5)}...`);
    }
    for (const id of actual) {
      if (seen.has(id)) {
        failed += 1;
        console.log(`  DUPLICATE ${label} page=${page} id=${id}`);
      }
      seen.add(id);
    }
  }
}
console.log(failed === 0 ? "分页核对全部通过" : `分页核对失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
