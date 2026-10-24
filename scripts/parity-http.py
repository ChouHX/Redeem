"""Node / Go 后端一致性对照。

两边各跑一份同源数据库，发同样的请求，逐字段 diff。
读接口要求完全一致；写接口把随机卡密、时间戳等易变值归一化后比较。

用法（两边必须是同一个库的副本，且都已启动）：

    cp app.db node.db && cp app.db go.db
    DB_PATH=./node.db NODE_BACKEND_PORT=5101 node src/server.js &
    DB_PATH=./go.db   NODE_BACKEND_PORT=5102 backend/redeem-server &
    ADMIN_TOKEN=<库里的 admin_token> python3 scripts/parity-http.py

写接口会改数据，重复跑之前请重新复制数据库，否则会出现无关差异。
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error

NODE = os.environ.get("NODE_URL", "http://127.0.0.1:5101")
GO = os.environ.get("GO_URL", "http://127.0.0.1:5102")
TOKEN = os.environ.get("ADMIN_TOKEN", "beacON028")

VOLATILE_KEYS = {
    "code",
    "normalized_code",
    "redeemed_at",
    "created_at",
    "updated_at",
    "access_expires_at",
    "expires_at",
    "data_deleted_at",
    "record_id",
    "record_ids",
    "formatted_line",
    "search_text",
    "serialized_value",
    "payload",
    "token",
    "size",
    "filename",
    "image_url",
}
VOLATILE_PATTERNS = [
    (re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$"), "<TIME>"),
    (re.compile(r"^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$"), "<CODE>"),
    (re.compile(r"^ad-\d+-[a-z0-9]+\.\w+$"), "<ADFILE>"),
]


def normalize(value, key=None):
    if isinstance(value, dict):
        return {k: normalize(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v, key) for v in value]
    if key in VOLATILE_KEYS:
        return "<VOLATILE>"
    if isinstance(value, str):
        for pattern, replacement in VOLATILE_PATTERNS:
            if pattern.match(value):
                return replacement
    return value


def call(base, method, path, body=None, token=None, raw=False):
    url = base + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = response.read().decode("utf-8", "replace")
            return response.status, (payload if raw else json.loads(payload))
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", "replace")
        try:
            return error.code, (payload if raw else json.loads(payload))
        except json.JSONDecodeError:
            return error.code, payload


# 已知的有意差异：库存列表里的 type_mail_protocols。
# Node 的列表 SELECT 漏了 types.mail_protocols，只能回落到 [mail_protocol]，
# 于是允许 imap+graph 的类型在列表里被显示成只有 imap。
# Go 侧补上了这一列，值更准；该字段前端不消费，仅服务端序列化用。
IGNORED_PATHS = ("type_mail_protocols",)


def diff(node_value, go_value, path="", out=None):
    if out is None:
        out = []
    if any(path.endswith(item) for item in IGNORED_PATHS):
        return out
    if type(node_value) is not type(go_value):
        # int / float 在 JSON 里可能不同型，数值相等就放过
        if isinstance(node_value, (int, float)) and isinstance(go_value, (int, float)):
            if float(node_value) == float(go_value):
                return out
        out.append(f"{path or '<root>'}: 类型 {type(node_value).__name__} vs {type(go_value).__name__}")
        return out
    if isinstance(node_value, dict):
        for key in sorted(set(node_value) | set(go_value)):
            if key not in node_value:
                out.append(f"{path}.{key}: Node 缺失")
            elif key not in go_value:
                out.append(f"{path}.{key}: Go 缺失")
            else:
                diff(node_value[key], go_value[key], f"{path}.{key}", out)
        return out
    if isinstance(node_value, list):
        if len(node_value) != len(go_value):
            out.append(f"{path}: 长度 {len(node_value)} vs {len(go_value)}")
            return out
        for index, (left, right) in enumerate(zip(node_value, go_value)):
            diff(left, right, f"{path}[{index}]", out)
        return out
    if node_value != go_value:
        out.append(f"{path}: {node_value!r} vs {go_value!r}")
    return out


CASES = []


def case(name, method, path, body=None, token=None, volatile=False):
    CASES.append((name, method, path, body, token, volatile))


# ---- 只读接口：要求完全一致 ----
case("catalog", "GET", "/api/redeem/catalog")
case("ui/ads", "GET", "/api/ui/ads")
case("ui/faq", "GET", "/api/ui/faq")
case("verify 正确", "POST", "/api/admin/verify", {"token": TOKEN})
case("verify 错误", "POST", "/api/admin/verify", {"token": "nope"})
case("system/config", "GET", "/api/system/config", token=TOKEN)
case("system/ads", "GET", "/api/system/ads", token=TOKEN)
case("system/faq", "GET", "/api/system/faq", token=TOKEN)
case("overview", "GET", "/api/redeem/admin/overview", token=TOKEN)
case("types 全量", "GET", "/api/redeem/admin/types?include_inactive=1", token=TOKEN)
case("types 仅启用", "GET", "/api/redeem/admin/types", token=TOKEN)
case("inventory p1", "GET", "/api/redeem/admin/inventory?page=1&page_size=5", token=TOKEN)
case("inventory 深页", "GET", "/api/redeem/admin/inventory?page=180&page_size=10", token=TOKEN)
case("inventory 按类型", "GET", "/api/redeem/admin/inventory?type_id=1&page=1&page_size=3", token=TOKEN)
case("inventory 按状态", "GET", "/api/redeem/admin/inventory?status=available&page=1&page_size=3", token=TOKEN)
case("inventory 按协议", "GET", "/api/redeem/admin/inventory?protocol=graph&page=1&page_size=3", token=TOKEN)
case("inventory 搜索长词", "GET", "/api/redeem/admin/inventory?q=outlook&page=1&page_size=3", token=TOKEN)
case("inventory 搜索短词", "GET", "/api/redeem/admin/inventory?q=ab&page=1&page_size=3", token=TOKEN)
case("inventory selection", "GET", "/api/redeem/admin/inventory/selection?status=available", token=TOKEN)
case("codes p1", "GET", "/api/redeem/admin/codes?page=1&page_size=5", token=TOKEN)
case("codes 按状态", "GET", "/api/redeem/admin/codes?status=unused&page=1&page_size=3", token=TOKEN)
case("codes 按数量", "GET", "/api/redeem/admin/codes?min_quantity=5&max_quantity=20&page=1&page_size=3", token=TOKEN)
case("codes selection", "GET", "/api/redeem/admin/codes/selection?status=unused", token=TOKEN)
case("records p1", "GET", "/api/redeem/admin/records?page=1&page_size=5", token=TOKEN)
case("records 按类型", "GET", "/api/redeem/admin/records?type_id=1&page=1&page_size=3", token=TOKEN)
case("records 详情", "GET", "/api/redeem/admin/records/15088", token=TOKEN)

# ---- 错误路径 ----
case("query 空码", "POST", "/api/redeem/query", {"code": ""})
case("query 不存在", "POST", "/api/redeem/query", {"code": "ZZZZ-ZZZZ-ZZZZ"})
case("exchange 空码", "POST", "/api/redeem/exchange", {"code": ""})
case("access 空码", "POST", "/api/redeem/access", {"code": ""})
case("未授权 overview", "GET", "/api/redeem/admin/overview")
case("错误令牌", "GET", "/api/redeem/admin/overview", token="bad")
case("类型不存在 PUT", "PUT", "/api/redeem/admin/types/999999", {"name": "x"}, token=TOKEN)
case("类型不存在 DELETE", "DELETE", "/api/redeem/admin/types/999999", token=TOKEN)
case("库存不存在 DELETE", "DELETE", "/api/redeem/admin/inventory/999999", token=TOKEN)
case("库存不存在 status", "POST", "/api/redeem/admin/inventory/999999/status", {"status": "available"}, token=TOKEN)
case("卡密不存在 DELETE", "DELETE", "/api/redeem/admin/codes/999999", token=TOKEN)
case("批量删除空选", "POST", "/api/redeem/admin/codes/batch-delete", {"code_ids": []}, token=TOKEN)
case("批量更新无项", "POST", "/api/redeem/admin/inventory/batch-update", {"inventory_ids": [1]}, token=TOKEN)

# ---- 取件与上游代理的入参校验（不触网）----
case("temp-messages 缺字段", "POST", "/api/temp-messages", {})
case("mailbox list 缺字段", "POST", "/api/mailboxes/temp/messages", {})
case("mailbox list 坏目录", "POST", "/api/mailboxes/temp/messages",
     {"email": "a@b.c", "refresh_token": "x", "folder": "weird"})
case("mailbox detail 缺字段", "POST", "/api/mailboxes/temp/messages/123", {})
case("mailbox detail 空 id", "POST", "/api/mailboxes/temp/messages/%20", {"email": "a@b.c", "refresh_token": "x"})
case("geminipro submit 缺卡密", "POST", "/api/geminipro/submit", {})
case("geminipro submit 缺账号", "POST", "/api/geminipro/submit", {"card": "X"})
case("geminipro submit 账号格式", "POST", "/api/geminipro/submit", {"card": "X", "accounts": ["a--b"]})

# ---- 写接口：易变值归一化后比较 ----
case("生成卡密", "POST", "/api/redeem/admin/codes/generate",
     {"type_id": 1, "count": 2, "quantity": 3, "note": "parity"}, token=TOKEN, volatile=True)
case("建类型", "POST", "/api/redeem/admin/types",
     {"slug": "parity-type", "name": "对照类型", "description": "d",
      "field_schema": [{"key": "account", "label": "账号", "required": True}],
      "import_delimiter": "----", "mail_protocol": "imap", "is_active": True},
     token=TOKEN, volatile=True)
case("库存导入", "POST", "/api/redeem/admin/inventory/import",
     {"type_id": 1, "mode": "append", "text": "parity-c@example.com----p----c----r\nparity-d@example.com----p----c----r"},
     token=TOKEN, volatile=True)
case("广告位保存", "POST", "/api/system/ads",
     {"enabled": True, "slots": [
         {"enabled": True, "title": "T1", "description": "D1", "image_url": "/a.png",
          "primary_action": {"label": "L1", "href": "https://a"}},
         {"enabled": False, "title": "T2", "description": "D2", "image_url": "",
          "primary_action": {"label": "L2", "href": "https://b"}}]},
     token=TOKEN)
case("广告位旧结构", "POST", "/api/system/ads",
     {"enabled": True, "title": "Legacy", "description": "old", "image_url": "/x.png"},
     token=TOKEN)
case("FAQ 保存", "POST", "/api/system/faq", {"html": "<h2>hi</h2>"}, token=TOKEN)
case("邮件限制", "POST", "/api/system/config", {"email_limit": 7}, token=TOKEN)
case("邮件限制越界", "POST", "/api/system/config", {"email_limit": 99}, token=TOKEN)


def main():
    failures = 0
    for name, method, path, body, token, volatile in CASES:
        node_status, node_payload = call(NODE, method, path, body, token)
        go_status, go_payload = call(GO, method, path, body, token)

        problems = []
        if node_status != go_status:
            problems.append(f"HTTP 状态 {node_status} vs {go_status}")

        if volatile:
            node_payload = normalize(node_payload)
            go_payload = normalize(go_payload)
        problems.extend(diff(node_payload, go_payload))

        if problems:
            failures += 1
            print(f"[差异] {name}")
            for item in problems[:12]:
                print("   ", item)
        else:
            print(f"[一致] {name}")

    print()
    print(f"用例 {len(CASES)} 个，差异 {failures} 个")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
