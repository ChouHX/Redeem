import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const PORT = String(5600 + Math.floor(Math.random() * 200));
const ADMIN_TOKEN = "integration-admin-token";
const ADMIN_PATH = "/secret-admin";
const baseUrl = `http://${HOST}:${PORT}`;

let tempDir = "";
let serverProcess;
let serverLogs = "";

function getAuthHeaders(extraHeaders = {}) {
  return {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    ...extraHeaders
  };
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  return { response, body };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`测试服务器启动失败:\n${serverLogs}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/admin/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "invalid-token" })
      });

      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`等待测试服务器启动超时:\n${serverLogs}`);
}

test.before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "outlook-manager-node-test-"));

  serverProcess = spawn(process.execPath, ["src/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_BACKEND_HOST: HOST,
      NODE_BACKEND_PORT: PORT,
      DB_PATH: path.join(tempDir, "test.db"),
      ADMIN_TOKEN,
      ADMIN_PATH
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  serverProcess.stdout.setEncoding("utf8");
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stdout.on("data", (chunk) => {
    serverLogs += chunk;
  });
  serverProcess.stderr.on("data", (chunk) => {
    serverLogs += chunk;
  });

  await waitForServer();
});

test.after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGINT");
    await once(serverProcess, "exit");
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("admin routes reject anonymous access", async () => {
  const adminPageResult = await request(ADMIN_PATH);
  assert.equal(adminPageResult.response.status, 200);
  assert.match(adminPageResult.body, /<div id="root"><\/div>/);

  const defaultAdminRouteResult = await request("/admin");
  assert.equal(defaultAdminRouteResult.response.status, 404);

  const systemConfigResult = await request("/api/system/config");
  assert.equal(systemConfigResult.response.status, 401);
  assert.equal(systemConfigResult.body.success, false);

  const redeemOverviewResult = await request("/api/redeem/admin/overview");
  assert.equal(redeemOverviewResult.response.status, 401);
  assert.equal(redeemOverviewResult.body.success, false);

  const inventoryDeleteResult = await request("/api/redeem/admin/inventory/1", {
    method: "DELETE"
  });
  assert.equal(inventoryDeleteResult.response.status, 401);
  assert.equal(inventoryDeleteResult.body.success, false);

  const redeemTypeCreateResult = await request("/api/redeem/admin/types", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Blocked Type",
      slug: "blocked-type",
      field_schema: [{ key: "account", label: "账号", required: true }]
    })
  });
  assert.equal(redeemTypeCreateResult.response.status, 401);
  assert.equal(redeemTypeCreateResult.body.success, false);
});

test("redeem flow supports custom types, inventory, codes and redemption", async () => {
  const typeCreateResult = await request("/api/redeem/admin/types", {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      name: "Outlook Exchange",
      slug: "outlook-exchange",
      description: "custom redeem type",
      import_delimiter: "----",
      is_active: true,
      field_schema: [
        { key: "account", label: "账号", required: true, sensitive: false },
        { key: "password", label: "密码", required: false, sensitive: true },
        { key: "oauth2id", label: "OAuth2 ID", required: false, sensitive: false },
        { key: "refreshtoken", label: "Refresh Token", required: true, sensitive: true }
      ]
    })
  });

  assert.equal(typeCreateResult.response.status, 200);
  assert.equal(typeCreateResult.body.success, true);
  const typeId = typeCreateResult.body.data.id;
  assert.equal(typeCreateResult.body.data.slug, "outlook-exchange");

  const backupTypeCreateResult = await request("/api/redeem/admin/types", {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      name: "Outlook Exchange Backup",
      slug: "outlook-exchange-backup",
      description: "backup redeem type",
      import_delimiter: "----",
      is_active: true,
      field_schema: [
        { key: "account", label: "账号", required: true, sensitive: false },
        { key: "password", label: "密码", required: false, sensitive: true },
        { key: "oauth2id", label: "OAuth2 ID", required: false, sensitive: false },
        { key: "refreshtoken", label: "Refresh Token", required: true, sensitive: true }
      ]
    })
  });

  assert.equal(backupTypeCreateResult.response.status, 200);
  assert.equal(backupTypeCreateResult.body.success, true);
  const backupTypeId = backupTypeCreateResult.body.data.id;

  const inventoryImportResult = await request("/api/redeem/admin/inventory/import", {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      type_id: typeId,
      mode: "append",
      text: [
        "first-mail@example.com----pass-1----oauth-1----refresh-1",
        "second-mail@example.com----pass-2----oauth-2----refresh-2",
        "third-mail@example.com----pass-3----oauth-3----refresh-3",
        "fourth-mail@example.com----pass-4----oauth-4----refresh-4",
        "fifth-mail@example.com----pass-5----oauth-5----refresh-5"
      ].join("\n")
    })
  });

  assert.equal(inventoryImportResult.response.status, 200);
  assert.equal(inventoryImportResult.body.success, true);
  assert.equal(inventoryImportResult.body.data.parse.parsed_count, 5);
  assert.equal(inventoryImportResult.body.data.import.added_count, 5);
  assert.equal(inventoryImportResult.body.data.import.skipped_count, 0);

  const inventoryListBeforeDelete = await request(
    `/api/redeem/admin/inventory?type_id=${typeId}&page=1&page_size=10`,
    {
      headers: getAuthHeaders()
    }
  );

  assert.equal(inventoryListBeforeDelete.response.status, 200);
  assert.equal(inventoryListBeforeDelete.body.success, true);
  assert.equal(inventoryListBeforeDelete.body.data.total, 5);

  const thirdInventory = inventoryListBeforeDelete.body.data.items.find(
    (item) => item.payload.account === "third-mail@example.com"
  );
  const fourthInventory = inventoryListBeforeDelete.body.data.items.find(
    (item) => item.payload.account === "fourth-mail@example.com"
  );
  const fifthInventory = inventoryListBeforeDelete.body.data.items.find(
    (item) => item.payload.account === "fifth-mail@example.com"
  );

  assert.ok(thirdInventory);
  assert.ok(fourthInventory);
  assert.ok(fifthInventory);

  const setInventoryUnavailableResult = await request(
    `/api/redeem/admin/inventory/${thirdInventory.id}/status`,
    {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "unavailable" })
    }
  );

  assert.equal(setInventoryUnavailableResult.response.status, 200);
  assert.equal(setInventoryUnavailableResult.body.success, true);
  assert.equal(setInventoryUnavailableResult.body.data.status, "unavailable");

  const unavailableInventoryListResult = await request(
    `/api/redeem/admin/inventory?type_id=${typeId}&status=unavailable&page=1&page_size=10`,
    {
      headers: getAuthHeaders()
    }
  );

  assert.equal(unavailableInventoryListResult.response.status, 200);
  assert.equal(unavailableInventoryListResult.body.success, true);
  assert.equal(unavailableInventoryListResult.body.data.total, 1);
  assert.equal(
    unavailableInventoryListResult.body.data.items[0].payload.account,
    "third-mail@example.com"
  );

  const inventoryBatchUpdateResult = await request(
    "/api/redeem/admin/inventory/batch-update",
    {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        inventory_ids: [fourthInventory.id, fifthInventory.id],
        type_id: backupTypeId,
        status: "available"
      })
    }
  );

  assert.equal(inventoryBatchUpdateResult.response.status, 200);
  assert.equal(inventoryBatchUpdateResult.body.success, true);
  assert.equal(inventoryBatchUpdateResult.body.data.updated_count, 2);
  assert.equal(inventoryBatchUpdateResult.body.data.skipped_count, 0);

  const backupInventoryListResult = await request(
    `/api/redeem/admin/inventory?type_id=${backupTypeId}&status=available&page=1&page_size=10`,
    {
      headers: getAuthHeaders()
    }
  );

  assert.equal(backupInventoryListResult.response.status, 200);
  assert.equal(backupInventoryListResult.body.success, true);
  assert.equal(backupInventoryListResult.body.data.total, 2);

  const deleteInventoryResult = await request(
    `/api/redeem/admin/inventory/${thirdInventory.id}`,
    {
      method: "DELETE",
      headers: getAuthHeaders()
    }
  );

  assert.equal(deleteInventoryResult.response.status, 200);
  assert.equal(deleteInventoryResult.body.success, true);

  const batchDeleteInventoryResult = await request(
    "/api/redeem/admin/inventory/batch-delete",
    {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        inventory_ids: [fifthInventory.id]
      })
    }
  );

  assert.equal(batchDeleteInventoryResult.response.status, 200);
  assert.equal(batchDeleteInventoryResult.body.success, true);
  assert.equal(batchDeleteInventoryResult.body.data.deleted_count, 1);

  const inventoryExportResult = await request(
    "/api/redeem/admin/inventory/export",
    {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        inventory_ids: inventoryListBeforeDelete.body.data.items
          .filter((item) =>
            ["first-mail@example.com", "second-mail@example.com"].includes(
              item.payload.account
            )
          )
          .map((item) => item.id)
      })
    }
  );

  assert.equal(inventoryExportResult.response.status, 200);
  assert.match(inventoryExportResult.body, /first-mail@example\.com----pass-1----oauth-1----refresh-1/);
  assert.match(inventoryExportResult.body, /second-mail@example\.com----pass-2----oauth-2----refresh-2/);

  const codeGenerateResult = await request("/api/redeem/admin/codes/generate", {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      type_id: typeId,
      count: 3,
      quantity: 2,
      note: "integration batch"
    })
  });

  assert.equal(codeGenerateResult.response.status, 200);
  assert.equal(codeGenerateResult.body.success, true);
  assert.equal(codeGenerateResult.body.data.items.length, 3);
  const [firstCode, secondCode, thirdCode] = codeGenerateResult.body.data.items;
  assert.match(firstCode.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.notEqual(firstCode.code, secondCode.code);
  assert.notEqual(secondCode.code, thirdCode.code);

  const codeBatchUpdateResult = await request("/api/redeem/admin/codes/batch-update", {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      code_ids: [secondCode.id, thirdCode.id],
      type_id: backupTypeId,
      quantity: 1
    })
  });

  assert.equal(codeBatchUpdateResult.response.status, 200);
  assert.equal(codeBatchUpdateResult.body.success, true);
  assert.equal(codeBatchUpdateResult.body.data.updated_count, 2);
  assert.equal(codeBatchUpdateResult.body.data.skipped_count, 0);

  const catalogResult = await request("/api/redeem/catalog");
  assert.equal(catalogResult.response.status, 200);
  assert.equal(catalogResult.body.success, true);
  const customCatalogType = catalogResult.body.data.types.find((item) => item.id === typeId);
  const backupCatalogType = catalogResult.body.data.types.find((item) => item.id === backupTypeId);
  assert.ok(customCatalogType);
  assert.ok(backupCatalogType);
  assert.equal(customCatalogType.available_inventory_count, 2);
  assert.equal(customCatalogType.available_code_count, 1);
  assert.equal(backupCatalogType.available_inventory_count, 1);
  assert.equal(backupCatalogType.available_code_count, 2);

  const redeemResult = await request("/api/redeem/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: firstCode.code.toLowerCase()
    })
  });

  assert.equal(redeemResult.response.status, 200);
  assert.equal(redeemResult.body.success, true);
  assert.equal(redeemResult.body.data.type.slug, "outlook-exchange");
  assert.equal(redeemResult.body.data.quantity, 2);
  assert.equal(redeemResult.body.data.redeemed_count, 2);
  assert.equal(redeemResult.body.data.items.length, 2);
  assert.equal(redeemResult.body.data.payload.account, "first-mail@example.com");
  assert.match(
    redeemResult.body.data.formatted_line,
    /first-mail@example\.com----pass-1----oauth-1----refresh-1/
  );
  assert.equal(redeemResult.body.data.items[1].payload.account, "second-mail@example.com");

  const unredeemedQueryResult = await request("/api/redeem/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: secondCode.code
    })
  });

  assert.equal(unredeemedQueryResult.response.status, 400);
  assert.equal(unredeemedQueryResult.body.success, false);
  assert.match(unredeemedQueryResult.body.message, /尚未兑换/);

  const redeemedQueryResult = await request("/api/redeem/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: firstCode.code
    })
  });

  assert.equal(redeemedQueryResult.response.status, 200);
  assert.equal(redeemedQueryResult.body.success, true);
  assert.equal(redeemedQueryResult.body.data.code, firstCode.code);
  assert.equal(redeemedQueryResult.body.data.item_count, 2);
  assert.deepEqual(
    redeemedQueryResult.body.data.items
      .map((item) => item.payload.account)
      .sort(),
    ["first-mail@example.com", "second-mail@example.com"]
  );

  const repeatRedeemResult = await request("/api/redeem/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: firstCode.code
    })
  });

  assert.equal(repeatRedeemResult.response.status, 400);
  assert.equal(repeatRedeemResult.body.success, false);
  assert.match(repeatRedeemResult.body.message, /已被使用/);

  const disableCodeBatchResult = await request(
    "/api/redeem/admin/codes/batch-status",
    {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        code_ids: [firstCode.id, secondCode.id, thirdCode.id],
        status: "disabled"
      })
    }
  );

  assert.equal(disableCodeBatchResult.response.status, 200);
  assert.equal(disableCodeBatchResult.body.success, true);
  assert.equal(disableCodeBatchResult.body.data.updated_count, 2);
  assert.equal(disableCodeBatchResult.body.data.skipped_count, 1);
  assert.equal(disableCodeBatchResult.body.data.status, "disabled");

  const disabledRedeemResult = await request("/api/redeem/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: secondCode.code
    })
  });

  assert.equal(disabledRedeemResult.response.status, 400);
  assert.equal(disabledRedeemResult.body.success, false);
  assert.match(disabledRedeemResult.body.message, /已禁用/);

  const codesListResult = await request(
    "/api/redeem/admin/codes?page=1&page_size=10",
    {
      headers: getAuthHeaders()
    }
  );

  assert.equal(codesListResult.response.status, 200);
  assert.equal(codesListResult.body.success, true);
  assert.equal(codesListResult.body.data.total, 3);
  assert.equal(
    codesListResult.body.data.items.find((item) => item.id === secondCode.id).quantity,
    1
  );
  assert.equal(
    codesListResult.body.data.items.find((item) => item.id === thirdCode.id).type_id,
    backupTypeId
  );
  assert.equal(
    codesListResult.body.data.items.filter((item) => item.status === "redeemed").length,
    1
  );
  assert.equal(
    codesListResult.body.data.items.filter((item) => item.status === "disabled").length,
    2
  );

  const codeExportResult = await request("/api/redeem/admin/codes/export", {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      type_id: backupTypeId,
      status: "disabled"
    })
  });

  assert.equal(codeExportResult.response.status, 200);
  assert.deepEqual(
    codeExportResult.body
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .sort(),
    [secondCode.code, thirdCode.code].sort()
  );

  const quantityFilteredCodesResult = await request(
    "/api/redeem/admin/codes?min_quantity=2&max_quantity=2&page=1&page_size=10",
    {
      headers: getAuthHeaders()
    }
  );

  assert.equal(quantityFilteredCodesResult.response.status, 200);
  assert.equal(quantityFilteredCodesResult.body.success, true);
  assert.equal(quantityFilteredCodesResult.body.data.total, 1);
  assert.equal(quantityFilteredCodesResult.body.data.items[0].id, firstCode.id);

  const deleteRedeemedCodeResult = await request(
    `/api/redeem/admin/codes/${firstCode.id}`,
    {
      method: "DELETE",
      headers: getAuthHeaders()
    }
  );

  assert.equal(deleteRedeemedCodeResult.response.status, 400);
  assert.equal(deleteRedeemedCodeResult.body.success, false);
  assert.match(deleteRedeemedCodeResult.body.message, /不能删除/);

  const deleteThirdCodeResult = await request(
    `/api/redeem/admin/codes/${thirdCode.id}`,
    {
      method: "DELETE",
      headers: getAuthHeaders()
    }
  );

  assert.equal(deleteThirdCodeResult.response.status, 200);
  assert.equal(deleteThirdCodeResult.body.success, true);

  const batchDeleteCodeResult = await request(
    "/api/redeem/admin/codes/batch-delete",
    {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        code_ids: [secondCode.id, firstCode.id]
      })
    }
  );

  assert.equal(batchDeleteCodeResult.response.status, 200);
  assert.equal(batchDeleteCodeResult.body.success, true);
  assert.equal(batchDeleteCodeResult.body.data.deleted_count, 1);
  assert.equal(batchDeleteCodeResult.body.data.skipped_count, 1);

  const recordsResult = await request(
    `/api/redeem/admin/records?type_id=${typeId}&page=1&page_size=10`,
    {
      headers: getAuthHeaders()
    }
  );

  assert.equal(recordsResult.response.status, 200);
  assert.equal(recordsResult.body.success, true);
  assert.equal(recordsResult.body.data.total, 1);
  assert.equal(recordsResult.body.data.items[0].code_id, firstCode.id);
  assert.equal(recordsResult.body.data.items[0].item_count, 2);

  const recordDetailResult = await request(
    `/api/redeem/admin/records/${firstCode.id}`,
    {
      headers: getAuthHeaders()
    }
  );

  assert.equal(recordDetailResult.response.status, 200);
  assert.equal(recordDetailResult.body.success, true);
  assert.equal(recordDetailResult.body.data.item_count, 2);
  assert.deepEqual(
    recordDetailResult.body.data.items
      .map((item) => item.payload.account)
      .sort(),
    ["first-mail@example.com", "second-mail@example.com"]
  );

  const overviewResult = await request("/api/redeem/admin/overview", {
    headers: getAuthHeaders()
  });

  assert.equal(overviewResult.response.status, 200);
  assert.equal(overviewResult.body.success, true);
  assert.equal(overviewResult.body.data.type_count >= 2, true);
  assert.equal(overviewResult.body.data.total_inventory_count >= 3, true);
  assert.equal(overviewResult.body.data.available_inventory_count >= 1, true);
  assert.equal(overviewResult.body.data.redeemed_inventory_count >= 1, true);
});
