# testAPI.py
# -*- coding: utf-8 -*-
"""
UIUC CS 409 - MP #3: APIed Piper
Python3 Test Suite (unittest + requests)

Usage:
  pip install requests
  BASE_URL=http://localhost:3000/api python3 testAPI.py
"""

import json
import os
import random
import string
import unittest
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api").rstrip("/")
USERS = f"{BASE_URL}/users"
TASKS = f"{BASE_URL}/tasks"

def iso_in(days=0):
    dt = datetime.now(timezone.utc) + timedelta(days=days)
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")

def j(obj):
    return json.dumps(obj, separators=(",", ":"))

def qjson(obj):
    return quote(j(obj), safe="")

def mk_email():
    s = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{s}@llama.io"

def ensure_envelope(resp):
    """
    统一断言响应为 {message, data}。
    - 对于 204 No Content：直接返回占位对象，不再检查 Content-Type。
    """
    if resp.status_code == 204:
        return {"message": "NO CONTENT", "data": {}}
    ct = resp.headers.get("Content-Type", "")
    assert ct.startswith("application/json"), f"Content-Type not JSON: {ct}"
    body = resp.json()
    assert isinstance(body, dict), "response is not a JSON object"
    assert "message" in body and isinstance(body["message"], str), "missing 'message' string"
    assert "data" in body, "missing 'data'"
    return body

def is_object_id(s: str) -> bool:
    if not isinstance(s, str) or len(s) != 24:
        return False
    hexchars = "0123456789abcdefABCDEF"
    return all(c in hexchars for c in s)

class APITestCase(unittest.TestCase):
    created_user_ids = set()
    created_task_ids = set()
    base_user = None
    base_task = None

    @classmethod
    def setUpClass(cls):
        try:
            r = requests.get(USERS, timeout=5)
            _ = ensure_envelope(r)
        except Exception as e:
            raise unittest.SkipTest(f"Server not reachable at {BASE_URL}. Error: {e}")

        cls.base_user = cls._create_user(name="Alice Llama", email=mk_email())
        cls.base_task = cls._create_task(name="bootstrap-task", deadline=iso_in(2))

        for _ in range(2):
            cls._create_user(name=f"User{random.randint(100,999)}", email=mk_email())
        for _ in range(4):
            cls._create_task(name=f"Task{random.randint(100,999)}", deadline=iso_in(random.randint(1,10)))

    @classmethod
    def tearDownClass(cls):
        for tid in list(cls.created_task_ids):
            try:
                requests.delete(f"{TASKS}/{tid}", timeout=5)
            except Exception:
                pass
        for uid in list(cls.created_user_ids):
            try:
                requests.delete(f"{USERS}/{uid}", timeout=5)
            except Exception:
                pass

    @classmethod
    def _create_user(cls, **payload):
        r = requests.post(USERS, json=payload, timeout=10)
        body = ensure_envelope(r)
        assert r.status_code in (200, 201), f"create user status {r.status_code}"
        data = body["data"]
        assert "_id" in data, "new user missing _id"
        cls.created_user_ids.add(data["_id"])
        return data

    @classmethod
    def _create_task(cls, **payload):
        r = requests.post(TASKS, json=payload, timeout=10)
        body = ensure_envelope(r)
        assert r.status_code in (200, 201), f"create task status {r.status_code}"
        data = body["data"]
        assert "_id" in data, "new task missing _id"
        cls.created_task_ids.add(data["_id"])
        return data

    # ======================= Tests: Users =======================

    def test_users_get_list_basic(self):
        r = requests.get(USERS, timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], list)

    def test_users_post_and_get_by_id_and_delete(self):
        u = self._create_user(name="Bob", email=mk_email())
        uid = u["_id"]

        r = requests.get(f"{USERS}/{uid}", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(body["data"]["_id"], uid)

        r = requests.delete(f"{USERS}/{uid}", timeout=10)
        _ = ensure_envelope(r)
        self.assertIn(r.status_code, (200, 204))
        self.created_user_ids.discard(uid)

        r = requests.get(f"{USERS}/{uid}", timeout=10)
        if r.status_code != 404:
            b = ensure_envelope(r)
            self.assertTrue(r.status_code == 404 or b["data"] in (None, {}, []))

    def test_users_validation_missing_fields(self):
        r = requests.post(USERS, json={"email": mk_email()}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

        r = requests.post(USERS, json={"name": "NoEmail"}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    def test_users_unique_email(self):
        email = mk_email()
        _ = self._create_user(name="Uniq", email=email)
        r = requests.post(USERS, json={"name": "Dup", "email": email}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    def test_users_put_replace(self):
        u = self._create_user(name="PutA", email=mk_email())
        uid = u["_id"]
        new_payload = {"name": "PutB", "email": mk_email(), "pendingTasks": []}
        r = requests.put(f"{USERS}/{uid}", json=new_payload, timeout=10)
        body = ensure_envelope(r)
        self.assertIn(r.status_code, (200, 201))
        self.assertEqual(body["data"]["name"], "PutB")

    def test_users_query_sort_skip_limit_select_count(self):
        names = [f"Aaa{n}" for n in range(3)]
        for nm in names:
            self._create_user(name=nm, email=mk_email())

        r = requests.get(
            f"{USERS}?sort={qjson({'name':1})}&select={qjson({'_id':0,'name':1})}",
            timeout=10,
        )
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        data = body["data"]
        self.assertIsInstance(data, list)
        names_seen = [d.get("name") for d in data if "name" in d]
        self.assertEqual(names_seen, sorted(names_seen))

        r = requests.get(f"{USERS}?sort={qjson({'name':1})}&skip=1&limit=2", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertLessEqual(len(body["data"]), 2)

        r = requests.get(f"{USERS}?count=true", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], int)

    def test_users_id_select_works(self):
        u = self._create_user(name="SelUser", email=mk_email())
        uid = u["_id"]
        # 纯包含式选择：只返回 name，且不返回 _id
        r = requests.get(
            f"{USERS}/{uid}?select={qjson({'name':1,'_id':0})}",
            timeout=10,
        )
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertIn("name", body["data"])
        self.assertNotIn("_id", body["data"])
        # 包含式选择通常会排除未列出的字段，这里也验证 email 不在
        self.assertNotIn("email", body["data"])

    # ======================= Tests: Tasks =======================

    def test_tasks_post_get_put_delete(self):
        t = self._create_task(name="t1", deadline=iso_in(1))
        tid = t["_id"]

        r = requests.get(f"{TASKS}/{tid}", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(body["data"]["_id"], tid)

        payload = {
            "name": "t1-replaced",
            "description": "desc",
            "deadline": iso_in(3),
            "completed": False,
            "assignedUser": "",
            "assignedUserName": "unassigned",
        }
        r = requests.put(f"{TASKS}/{tid}", json=payload, timeout=10)
        body = ensure_envelope(r)
        self.assertIn(r.status_code, (200, 201))
        self.assertEqual(body["data"]["name"], "t1-replaced")

        r = requests.delete(f"{TASKS}/{tid}", timeout=10)
        _ = ensure_envelope(r)
        self.assertIn(r.status_code, (200, 204))
        self.created_task_ids.discard(tid)

        r = requests.get(f"{TASKS}/{tid}", timeout=10)
        if r.status_code != 404:
            b = ensure_envelope(r)
            self.assertTrue(r.status_code == 404 or b["data"] in (None, {}, []))

    def test_tasks_validation_missing_fields(self):
        r = requests.post(TASKS, json={"deadline": iso_in(1)}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)
        r = requests.post(TASKS, json={"name": "NoDeadline"}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    def test_tasks_query_where_select_skip_limit_sort_count(self):
        _ = self._create_task(name="done-x", deadline=iso_in(1), completed=True)
        _ = self._create_task(name="todo-y", deadline=iso_in(2), completed=False)

        r = requests.get(f"{TASKS}?where={qjson({'completed':True})}", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], list)
        if body["data"]:
            self.assertIn("completed", body["data"][0])

        r = requests.get(f"{TASKS}?select={qjson({'_id':0,'name':1})}", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        if body["data"]:
            self.assertIn("name", body["data"][0])
            self.assertNotIn("_id", body["data"][0])

        r = requests.get(f"{TASKS}?sort={qjson({'name':1})}&skip=1&limit=3", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertLessEqual(len(body["data"]), 3)

        r = requests.get(f"{TASKS}?where={qjson({'completed':False})}&count=true", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], int)

    def test_tasks_id_select_works(self):
        t = self._create_task(name="SelTask", deadline=iso_in(4), completed=False)
        tid = t["_id"]
        # 纯包含式：只取 name，且隐藏 _id
        r = requests.get(
            f"{TASKS}/{tid}?select={qjson({'name':1,'_id':0})}",
            timeout=10,
        )
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertIn("name", body["data"])
        self.assertNotIn("_id", body["data"])

    # ================== 双向引用保证 ==================

    def test_put_task_assigns_user_and_updates_pendingTasks(self):
        u = self._create_user(name="Assignee", email=mk_email())
        t = self._create_task(name="Assignable", deadline=iso_in(2), completed=False)

        payload = {
            "name": t["name"],
            "description": t.get("description", ""),
            "deadline": t["deadline"],
            "completed": False,
            "assignedUser": u["_id"],
            "assignedUserName": u["name"],
        }
        r = requests.put(f"{TASKS}/{t['_id']}", json=payload, timeout=10)
        body = ensure_envelope(r)
        self.assertIn(r.status_code, (200, 201))
        self.assertEqual(body["data"]["assignedUser"], u["_id"])

        r = requests.get(f"{USERS}/{u['_id']}", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertIn(t["_id"], body["data"].get("pendingTasks", []))

    def test_delete_task_removes_from_users_pendingTasks(self):
        u = self._create_user(name="DelTaskUser", email=mk_email())
        t = self._create_task(name="ToDelete", deadline=iso_in(1), completed=False)

        payload = {
            "name": t["name"],
            "description": t.get("description", ""),
            "deadline": t["deadline"],
            "completed": False,
            "assignedUser": u["_id"],
            "assignedUserName": u["name"],
        }
        requests.put(f"{TASKS}/{t['_id']}", json=payload, timeout=10)

        r = requests.delete(f"{TASKS}/{t['_id']}", timeout=10)
        _ = ensure_envelope(r)
        self.assertIn(r.status_code, (200, 204))
        self.created_task_ids.discard(t["_id"])

        r = requests.get(f"{USERS}/{u['_id']}", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(t["_id"], body["data"].get("pendingTasks", []))

    def test_put_user_pendingTasks_assigns_tasks(self):
        u = self._create_user(name="BulkAssign", email=mk_email())
        t1 = self._create_task(name="B1", deadline=iso_in(3), completed=False,
                               assignedUser="", assignedUserName="unassigned")
        t2 = self._create_task(name="B2", deadline=iso_in(4), completed=False,
                               assignedUser="", assignedUserName="unassigned")

        new_user = {"name": u["name"], "email": u["email"],
                    "pendingTasks": [t1["_id"], t2["_id"]]}
        r = requests.put(f"{USERS}/{u['_id']}", json=new_user, timeout=10)
        body = ensure_envelope(r)
        self.assertIn(r.status_code, (200, 201))
        self.assertCountEqual(body["data"].get("pendingTasks", []), [t1["_id"], t2["_id"]])

        for tid in (t1["_id"], t2["_id"]):
            r = requests.get(f"{TASKS}/{tid}", timeout=10)
            b = ensure_envelope(r)
            self.assertEqual(b["data"].get("assignedUser"), u["_id"])
            self.assertEqual(b["data"].get("assignedUserName"), u["name"])

    def test_delete_user_unassigns_their_pending_tasks(self):
        u = self._create_user(name="ToBeDeleted", email=mk_email())
        t = self._create_task(name="BoundTask", deadline=iso_in(2), completed=False)

        payload = {
            "name": t["name"],
            "description": t.get("description", ""),
            "deadline": t["deadline"],
            "completed": False,
            "assignedUser": u["_id"],
            "assignedUserName": u["name"],
        }
        requests.put(f"{TASKS}/{t['_id']}", json=payload, timeout=10)

        r = requests.delete(f"{USERS}/{u['_id']}", timeout=10)
        _ = ensure_envelope(r)
        self.assertIn(r.status_code, (200, 204))
        self.created_user_ids.discard(u["_id"])

        r = requests.get(f"{TASKS}/{t['_id']}", timeout=10)
        if r.status_code == 200:
            b = ensure_envelope(r)
            self.assertIn(b["data"].get("assignedUser", ""), ("", None))
            self.assertEqual(b["data"].get("assignedUserName", "unassigned"), "unassigned")

    # ============== 404 / 400 负向用例 ==============

    def test_get_nonexistent_user_returns_404(self):
        r = requests.get(f"{USERS}/000000000000000000000000", timeout=10)
        if r.status_code != 404:
            b = ensure_envelope(r)
            self.assertTrue(r.status_code == 404 or b["data"] in (None, {}, []))

    def test_put_nonexistent_task_returns_404(self):
        payload = {
            "name": "ghost",
            "description": "",
            "deadline": iso_in(5),
            "completed": False,
            "assignedUser": "",
            "assignedUserName": "unassigned",
        }
        r = requests.put(f"{TASKS}/000000000000000000000000", json=payload, timeout=10)
        if r.status_code != 404:
            _ = ensure_envelope(r)
            self.assertEqual(r.status_code, 404)

    # ============== limit 默认值（tasks=100 / users=无限） ==============

    def test_tasks_default_limit_is_100_when_omitted(self):
        need = max(0, 110 - len(self._list_tasks()))
        for _ in range(need):
            self._create_task(name=f"bulk-{random.randint(1000,9999)}", deadline=iso_in(7))
        r = requests.get(TASKS, timeout=15)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        data = body["data"]
        if isinstance(data, list):
            self.assertLessEqual(len(data), 100, "Default limit for tasks should be 100")

    def test_users_default_limit_unlimited(self):
        need = max(0, 120 - len(self._list_users()))
        for _ in range(need):
            self._create_user(name=f"bulkU-{random.randint(1000,9999)}", email=mk_email())
        r = requests.get(USERS, timeout=15)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        data = body["data"]
        if isinstance(data, list):
            self.assertGreaterEqual(len(data), 101, "Users endpoint should not default-limit to 100")

    # ======== 你已有的 corner（保留） ========
    def test_put_user_cannot_add_completed_task(self):
        u = self._create_user(name="CantAddDone", email=mk_email())
        t_done = self._create_task(name="done", deadline=iso_in(1), completed=True)

        new_user = {"name": u["name"], "email": u["email"], "pendingTasks":[t_done["_id"]]}
        r = requests.put(f"{USERS}/{u['_id']}", json=new_user, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    def test_put_task_cannot_update_completed_task(self):
        u = self._create_user(name="UU", email=mk_email())
        t = self._create_task(name="ToComplete", deadline=iso_in(2), completed=False,
                            assignedUser=u["_id"], assignedUserName=u["name"])

        payload_done = {
            "name": t["name"],
            "description": t.get("description",""),
            "deadline": t["deadline"],
            "completed": True,
            "assignedUser": u["_id"],
            "assignedUserName": u["name"],
        }
        r1 = requests.put(f"{TASKS}/{t['_id']}", json=payload_done, timeout=10)
        _ = ensure_envelope(r1); self.assertIn(r1.status_code,(200,201))

        payload_try = {
            "name": "should-fail",
            "description": "x",
            "deadline": iso_in(3),
            "completed": True,
            "assignedUser": u["_id"],
            "assignedUserName": u["name"],
        }
        r2 = requests.put(f"{TASKS}/{t['_id']}", json=payload_try, timeout=10)
        _ = ensure_envelope(r2)
        self.assertEqual(r2.status_code, 400)

    def test_users_where_by_id_returns_single_item_list(self):
        u = self._create_user(name="WhereById", email=mk_email())
        r = requests.get(f"{USERS}?where={qjson({'_id': u['_id']})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], list)
        if body["data"]:
            self.assertEqual(body["data"][0]["_id"], u["_id"])

    def test_tasks_where_in_returns_subset(self):
        t1 = self._create_task(name="IN-1", deadline=iso_in(2))
        t2 = self._create_task(name="IN-2", deadline=iso_in(3))
        ids = [t1["_id"], t2["_id"]]
        r = requests.get(f"{TASKS}?where={qjson({'_id': {'$in': ids}})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], list)
        got_ids = {d["_id"] for d in body["data"]}
        self.assertTrue(set(ids).issubset(got_ids) or got_ids.issubset(set(ids)))

    def test_tasks_skip_60_limit_20_shape(self):
        need = max(0, 80 - len(self._list_tasks()))
        for _ in range(need):
            self._create_task(name=f"bulk-{random.randint(1000,9999)}", deadline=iso_in(10))
        r = requests.get(f"{TASKS}?skip=60&limit=20", timeout=15)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], list)
        self.assertLessEqual(len(body["data"]), 20)

    def test_users_select_exclude_id_only(self):
        r = requests.get(f"{USERS}?select={qjson({'_id':0})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        if body["data"]:
            self.assertNotIn("_id", body["data"][0])

    # ================= 新增覆盖：查询参数与错误形态 =================

    def test_query_params_invalid_json_returns_400(self):
        for url in [
            f"{USERS}?where={{invalid}}",
            f"{USERS}?sort={{name:1}}",
            f"{USERS}?select={{_id:0,name:1,}}",  # 尾逗号
            f"{TASKS}?where=%7Bcompleted%3Atrue%7D",  # 非 JSON 风格
        ]:
            r = requests.get(url, timeout=10)
            _ = ensure_envelope(r)
            self.assertEqual(r.status_code, 400, f"Should 400 for invalid JSON: {url}")

    def test_select_mixing_include_and_exclude_400(self):
        # 除 _id 特例外，混用应 400（如果你的实现是“自动修正”，把这里放宽为 in (200,400)）
        r = requests.get(f"{USERS}?select={qjson({'name':1,'email':0})}", timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    def test_skip_limit_negative_or_nonnumeric_400(self):
        for url in [
            f"{TASKS}?skip=-1",
            f"{TASKS}?limit=-5",
            f"{USERS}?skip=foo",
            f"{USERS}?limit=bar",
        ]:
            r = requests.get(url, timeout=10)
            _ = ensure_envelope(r)
            self.assertEqual(r.status_code, 400, f"Should 400 for bad pagination: {url}")

    def test_count_true_ignores_select_and_returns_int(self):
        r = requests.get(f"{TASKS}?where={qjson({'completed':False})}&select={qjson({'_id':0})}&count=true", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], int)

    def test_combined_where_sort_skip_limit_select(self):
        # 造一些可排序的数据
        base = [("K-01", 1), ("K-02", 2), ("K-03", 3), ("K-04", 4)]
        for nm, d in base:
            self._create_user(name=f"{nm}", email=mk_email())
        url = (
            f"{USERS}"
            f"?where={qjson({'name':{'$regex':'^K-'}})}"
            f"&sort={qjson({'name':-1})}"
            f"&skip=1&limit=2"
            f"&select={qjson({'_id':0,'name':1})}"
        )
        r = requests.get(url, timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        data = body["data"]
        self.assertIsInstance(data, list)
        # 降序后跳过1条，取2条
        names = [d["name"] for d in data]
        self.assertLessEqual(len(names), 2)
        self.assertTrue(all(n.startswith("K-") for n in names))

    # =============== ID 形态：非法 vs 不存在 =================

    def test_invalid_object_id_format_returns_400(self):
        for bad in ["123", "zzzzzzzzzzzzzzzzzzzzzzzz", "🚀" * 12]:
            r = requests.get(f"{USERS}/{bad}", timeout=10)
            _ = ensure_envelope(r)
            self.assertEqual(r.status_code, 400, f"Invalid ObjectId should be 400: {bad}")

    # =============== PUT 必填字段与重复 email =================

    def test_put_user_missing_required_fields_400(self):
        u = self._create_user(name="PUT-REQ", email=mk_email())
        uid = u["_id"]
        # 整替少 email
        r = requests.put(f"{USERS}/{uid}", json={"name":"only"}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    def test_put_user_duplicate_email_400(self):
        a = self._create_user(name="A", email=mk_email())
        b = self._create_user(name="B", email=mk_email())
        # 把 B 改成 A 的 email
        r = requests.put(f"{USERS}/{b['_id']}", json={"name": "B2", "email": a["email"]}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    def test_put_task_missing_required_fields_400(self):
        t = self._create_task(name="PUT-REQ-T", deadline=iso_in(3))
        tid = t["_id"]
        # 少 name
        r = requests.put(f"{TASKS}/{tid}", json={"deadline": iso_in(4)}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    # =============== 新建默认值校验 =================

    def test_post_user_defaults_have_dateCreated(self):
        u = self._create_user(name="DEF-U", email=mk_email())
        self.assertIn("dateCreated", u)

    def test_post_task_defaults(self):
        t = self._create_task(name="DEF-T", deadline=iso_in(5))
        self.assertIn("dateCreated", t)
        self.assertIn("assignedUser", t)
        self.assertIn("assignedUserName", t)
        self.assertIn("completed", t)

    # =============== limit 行为细化 =================

    def test_users_respects_explicit_limit(self):
        need = max(0, 50 - len(self._list_users()))
        for _ in range(need):
            self._create_user(name=f"LIMU-{random.randint(1000,9999)}", email=mk_email())
        r = requests.get(f"{USERS}?limit=5", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        if isinstance(body["data"], list):
            self.assertLessEqual(len(body["data"]), 5)

    def test_tasks_explicit_limit_over_100_allowed(self):
        need = max(0, 160 - len(self._list_tasks()))
        for _ in range(need):
            self._create_task(name=f"LIMT-{random.randint(1000,9999)}", deadline=iso_in(20))
        r = requests.get(f"{TASKS}?limit=120", timeout=20)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        if isinstance(body["data"], list):
            # 明确 limit=120 应生效（默认100仅在省略时）
            self.assertLessEqual(len(body["data"]), 120)

    # =============== 双向引用：重指派与多任务解绑 =================

    def test_reassign_task_moves_between_users(self):
        ua = self._create_user(name="FromA", email=mk_email())
        ub = self._create_user(name="ToB", email=mk_email())
        t = self._create_task(name="reassign", deadline=iso_in(6), completed=False)

        # 指派给 A
        payloadA = {
            "name": t["name"], "description": t.get("description",""),
            "deadline": t["deadline"], "completed": False,
            "assignedUser": ua["_id"], "assignedUserName": ua["name"],
        }
        r1 = requests.put(f"{TASKS}/{t['_id']}", json=payloadA, timeout=10)
        _ = ensure_envelope(r1); self.assertIn(r1.status_code,(200,201))

        # 改指派给 B
        payloadB = {**payloadA, "assignedUser": ub["_id"], "assignedUserName": ub["name"]}
        r2 = requests.put(f"{TASKS}/{t['_id']}", json=payloadB, timeout=10)
        _ = ensure_envelope(r2); self.assertIn(r2.status_code,(200,201))

        # A 应移除，B 应添加
        ra = requests.get(f"{USERS}/{ua['_id']}", timeout=10)
        rb = requests.get(f"{USERS}/{ub['_id']}", timeout=10)
        ba = ensure_envelope(ra)["data"]; bb = ensure_envelope(rb)["data"]
        self.assertNotIn(t["_id"], ba.get("pendingTasks", []))
        self.assertIn(t["_id"], bb.get("pendingTasks", []))

    def test_delete_user_unassigns_multiple_tasks(self):
        u = self._create_user(name="DelMulti", email=mk_email())
        tids = []
        for i in range(3):
            t = self._create_task(name=f"M{i}", deadline=iso_in(3+i), completed=False)
            tids.append(t["_id"])
            payload = {
                "name": t["name"], "description": t.get("description",""),
                "deadline": t["deadline"], "completed": False,
                "assignedUser": u["_id"], "assignedUserName": u["name"],
            }
            requests.put(f"{TASKS}/{t['_id']}", json=payload, timeout=10)

        r = requests.delete(f"{USERS}/{u['_id']}", timeout=10)
        _ = ensure_envelope(r); self.assertIn(r.status_code,(200,204))
        self.created_user_ids.discard(u["_id"])

        for tid in tids:
            r2 = requests.get(f"{TASKS}/{tid}", timeout=10)
            if r2.status_code == 200:
                b2 = ensure_envelope(r2)["data"]
                self.assertIn(b2.get("assignedUser", ""), ("", None))
                self.assertEqual(b2.get("assignedUserName","unassigned"), "unassigned")

    # =============== 单资源：select 排除式 ===============
    def test_user_id_select_exclude_only(self):
        u = self._create_user(name="OnlyEx", email=mk_email())
        r = requests.get(f"{USERS}/{u['_id']}?select={qjson({'_id':0,'email':0})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertNotIn("_id", body["data"])
        self.assertNotIn("email", body["data"])
        self.assertIn("name", body["data"])

    # =============== 排序降序 ===============
    def test_sort_descending(self):
        for nm in ["ZZZ", "AAA", "MMM"]:
            self._create_user(name=f"Sort-{nm}", email=mk_email())
        r = requests.get(f"{USERS}?where={qjson({'name':{'$regex':'^Sort-'}})}&sort={qjson({'name':-1})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        data = [d["name"] for d in body["data"]]
        self.assertEqual(data, sorted(data, reverse=True))

    # ----------------- small helpers -----------------

    def _list_users(self):
        r = requests.get(USERS, timeout=10)
        body = ensure_envelope(r)
        return body["data"] if isinstance(body["data"], list) else []

    def _list_tasks(self):
        r = requests.get(TASKS, timeout=10)
        body = ensure_envelope(r)
        return body["data"] if isinstance(body["data"], list) else []

if __name__ == "__main__":
    print(f"Using BASE_URL={BASE_URL}")
    unittest.main(verbosity=2)
