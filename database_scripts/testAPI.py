# test_api.py
# -*- coding: utf-8 -*-
"""
UIUC CS 409 - MP #3: APIed Piper
Python3 Test Suite (unittest + requests)

Usage:
  pip install requests
  BASE_URL=http://localhost:3000/api python3 test_api.py
  # 若未设置 BASE_URL，默认 http://localhost:3000/api

测试覆盖点：
1) CRUD：/users, /users/:id, /tasks, /tasks/:id
2) 响应格式：必须是 {"message": <str>, "data": <obj>}
3) 状态码：200 / 201 / 204 / 400 / 404 / 500（只断言前五种出现时的正确性）
4) 查询参数：where / sort / select / skip / limit / count
   - 组合测试，例如 where+sort+skip+limit
   - 针对单资源（/users/:id、/tasks/:id）的 +select 测试
5) 校验：
   - 用户必须有 name、email；email 唯一
   - 任务必须有 name、deadline
6) 双向引用保证：
   - PUT Task 设置 assignedUser/assignedUserName -> 用户 pendingTasks 包含该任务
   - DELETE Task -> 从其 assignedUser 的 pendingTasks 移除
   - PUT User 带 pendingTasks -> 对应任务被分配给该用户（assignedUser/assignedUserName）
   - DELETE User -> 该用户的未完成任务自动解绑（assignedUser=""，assignedUserName="unassigned"）

备注：
- 测试会创建临时用户/任务，并在 tearDownClass 清理（尽力 best-effort）。
- 为了稳健，部分断言在资源较少时会先补充创建。
- deadline 使用 ISO8601（UTC），例如 "2025-11-05T00:00:00.000Z"
"""

import json
import os
import random
import string
import time
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
    """把 JSON 放到查询串中，注意要 URL 编码。"""
    return quote(j(obj), safe="")

def mk_email():
    s = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{s}@llama.io"

def ensure_envelope(resp):
    assert resp.headers.get("Content-Type","").startswith("application/json"), f"Content-Type not JSON: {resp.headers.get('Content-Type')}"
    body = resp.json()
    assert isinstance(body, dict), "response is not a JSON object"
    assert "message" in body and isinstance(body["message"], str), "missing 'message' string"
    assert "data" in body, "missing 'data'"
    return body

class APITestCase(unittest.TestCase):
    created_user_ids = set()
    created_task_ids = set()
    base_user = None
    base_task = None

    @classmethod
    def setUpClass(cls):
        # 基础连通性检查
        try:
            r = requests.get(USERS, timeout=5)
            _ = ensure_envelope(r)
        except Exception as e:
            raise unittest.SkipTest(f"Server not reachable at {BASE_URL}. Error: {e}")

        # 创建一个基础用户和任务
        cls.base_user = cls._create_user(name="Alice Llama", email=mk_email())
        cls.base_task = cls._create_task(name="bootstrap-task", deadline=iso_in(2))

        # 确保存在至少 3 个用户 & 5 个任务，便于排序/分页测试
        for _ in range(2):
            cls._create_user(name=f"User{random.randint(100,999)}", email=mk_email())
        for _ in range(4):
            cls._create_task(name=f"Task{random.randint(100,999)}", deadline=iso_in(random.randint(1,10)))

    @classmethod
    def tearDownClass(cls):
        # 先删任务（避免用户删除时约束阻碍）
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

    # ----------------- helper: create/get/update/delete -----------------

    @classmethod
    def _create_user(cls, **payload):
        r = requests.post(USERS, json=payload, timeout=10)
        body = ensure_envelope(r)
        assert r.status_code in (200,201), f"create user status {r.status_code}"
        data = body["data"]
        assert "_id" in data, "new user missing _id"
        cls.created_user_ids.add(data["_id"])
        return data

    @classmethod
    def _create_task(cls, **payload):
        r = requests.post(TASKS, json=payload, timeout=10)
        body = ensure_envelope(r)
        assert r.status_code in (200,201), f"create task status {r.status_code}"
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

        # GET by id
        r = requests.get(f"{USERS}/{uid}", timeout=10)
        body = ensure_envelope(r)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(body["data"]["_id"], uid)

        # DELETE
        r = requests.delete(f"{USERS}/{uid}", timeout=10)
        body = ensure_envelope(r)
        self.assertIn(r.status_code, (200,204))
        self.created_user_ids.discard(uid)

        # 再 GET 应该 404
        r = requests.get(f"{USERS}/{uid}", timeout=10)
        if r.status_code != 404:
            # 兼容某些实现返回 200 但 data=None
            b = ensure_envelope(r)
            self.assertTrue(r.status_code == 404 or b["data"] in (None, {}, []))

    def test_users_validation_missing_fields(self):
        # 缺 name
        r = requests.post(USERS, json={"email": mk_email()}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

        # 缺 email
        r = requests.post(USERS, json={"name": "NoEmail"}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    def test_users_unique_email(self):
        email = mk_email()
        u1 = self._create_user(name="Uniq", email=email)
        # 重复 email
        r = requests.post(USERS, json={"name":"Dup","email":email}, timeout=10)
        _ = ensure_envelope(r)
        self.assertEqual(r.status_code, 400)

    def test_users_put_replace(self):
        u = self._create_user(name="PutA", email=mk_email())
        uid = u["_id"]
        new_payload = {"name":"PutB","email":mk_email(),"pendingTasks":[]}
        r = requests.put(f"{USERS}/{uid}", json=new_payload, timeout=10)
        body = ensure_envelope(r)
        self.assertIn(r.status_code, (200,201))
        self.assertEqual(body["data"]["name"], "PutB")

    def test_users_query_sort_skip_limit_select_count(self):
        # 创建一些有序名字，方便 sort
        names = [f"Aaa{n}" for n in range(3)]
        for nm in names:
            self._create_user(name=nm, email=mk_email())

        # sort asc
        r = requests.get(f"{USERS}?sort={qjson({'name':1})}&select={qjson({'_id':0,'name':1})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        data = body["data"]; self.assertIsInstance(data, list)
        # 若有 name 字段，确认有序（某些实现可能返回包含无 name 的条目，做容错）
        names_seen = [d.get("name") for d in data if "name" in d]
        self.assertEqual(names_seen, sorted(names_seen))

        # skip & limit （取 2 条）
        r = requests.get(f"{USERS}?sort={qjson({'name':1})}&skip=1&limit=2", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertLessEqual(len(body["data"]), 2)

        # count=true
        r = requests.get(f"{USERS}?count=true", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], int)

    def test_users_id_select_works(self):
        u = self._create_user(name="SelUser", email=mk_email())
        uid = u["_id"]
        # 仅返回 name，不返回 email/_id
        r = requests.get(f"{USERS}/{uid}?select={qjson({'name':1,'_id':0,'email':0})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertIn("name", body["data"])
        self.assertNotIn("_id", body["data"])
        self.assertNotIn("email", body["data"])

    # ======================= Tests: Tasks =======================

    def test_tasks_post_get_put_delete(self):
        t = self._create_task(name="t1", deadline=iso_in(1))
        tid = t["_id"]

        # GET by id
        r = requests.get(f"{TASKS}/{tid}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertEqual(body["data"]["_id"], tid)

        # PUT replace
        payload = {
            "name":"t1-replaced",
            "description":"desc",
            "deadline": iso_in(3),
            "completed": False,
            "assignedUser":"", "assignedUserName":"unassigned"
        }
        r = requests.put(f"{TASKS}/{tid}", json=payload, timeout=10)
        body = ensure_envelope(r); self.assertIn(r.status_code,(200,201))
        self.assertEqual(body["data"]["name"], "t1-replaced")

        # DELETE
        r = requests.delete(f"{TASKS}/{tid}", timeout=10)
        _ = ensure_envelope(r); self.assertIn(r.status_code,(200,204))
        self.created_task_ids.discard(tid)

        # 再 GET 应 404
        r = requests.get(f"{TASKS}/{tid}", timeout=10)
        if r.status_code != 404:
            b = ensure_envelope(r)
            self.assertTrue(r.status_code == 404 or b["data"] in (None, {}, []))

    def test_tasks_validation_missing_fields(self):
        # 缺 name
        r = requests.post(TASKS, json={"deadline": iso_in(1)}, timeout=10)
        _ = ensure_envelope(r); self.assertEqual(r.status_code, 400)
        # 缺 deadline
        r = requests.post(TASKS, json={"name": "NoDeadline"}, timeout=10)
        _ = ensure_envelope(r); self.assertEqual(r.status_code, 400)

    def test_tasks_query_where_select_skip_limit_sort_count(self):
        # 创建一些完成/未完成的任务，便于 where
        t1 = self._create_task(name="done-x", deadline=iso_in(1), completed=True)
        t2 = self._create_task(name="todo-y", deadline=iso_in(2), completed=False)

        # where completed=true
        r = requests.get(f"{TASKS}?where={qjson({'completed':True})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], list)
        # 不能强断每项都 true（若数据很多/实现差异），但抽样检查
        if body["data"]:
            self.assertIn("completed", body["data"][0])

        # select exclude _id
        r = requests.get(f"{TASKS}?select={qjson({'_id':0,'name':1})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        if body["data"]:
            self.assertIn("name", body["data"][0])
            self.assertNotIn("_id", body["data"][0])

        # sort + skip + limit 组合
        r = requests.get(f"{TASKS}?sort={qjson({'name':1})}&skip=1&limit=3", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertLessEqual(len(body["data"]), 3)

        # count=true
        r = requests.get(f"{TASKS}?where={qjson({'completed':False})}&count=true", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertIsInstance(body["data"], int)

    def test_tasks_id_select_works(self):
        t = self._create_task(name="SelTask", deadline=iso_in(4), completed=False)
        tid = t["_id"]
        r = requests.get(f"{TASKS}/{tid}?select={qjson({'name':1,'_id':0,'completed':0})}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertIn("name", body["data"])
        self.assertNotIn("_id", body["data"])
        self.assertNotIn("completed", body["data"])

    # ================== 双向引用保证（核心要求） ==================

    def test_put_task_assigns_user_and_updates_pendingTasks(self):
        # 先有一个用户和一个未分配任务
        u = self._create_user(name="Assignee", email=mk_email())
        t = self._create_task(name="Assignable", deadline=iso_in(2), completed=False)

        # PUT task，设置 assignedUser & assignedUserName
        payload = {
            "name": t["name"],
            "description": t.get("description",""),
            "deadline": t["deadline"],
            "completed": False,
            "assignedUser": u["_id"],
            "assignedUserName": u["name"]
        }
        r = requests.put(f"{TASKS}/{t['_id']}", json=payload, timeout=10)
        body = ensure_envelope(r); self.assertIn(r.status_code,(200,201))
        self.assertEqual(body["data"]["assignedUser"], u["_id"])

        # GET user，pendingTasks 应包含该任务
        r = requests.get(f"{USERS}/{u['_id']}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        p = body["data"].get("pendingTasks", [])
        self.assertIn(t["_id"], p, "User.pendingTasks should include the assigned task")

    def test_delete_task_removes_from_users_pendingTasks(self):
        u = self._create_user(name="DelTaskUser", email=mk_email())
        t = self._create_task(name="ToDelete", deadline=iso_in(1), completed=False)
        # 分配
        payload = {
            "name": t["name"],
            "description": t.get("description",""),
            "deadline": t["deadline"],
            "completed": False,
            "assignedUser": u["_id"],
            "assignedUserName": u["name"]
        }
        requests.put(f"{TASKS}/{t['_id']}", json=payload, timeout=10)

        # 删除任务
        r = requests.delete(f"{TASKS}/{t['_id']}", timeout=10)
        _ = ensure_envelope(r); self.assertIn(r.status_code,(200,204))
        self.created_task_ids.discard(t["_id"])

        # 用户 pendingTasks 不应再包含
        r = requests.get(f"{USERS}/{u['_id']}", timeout=10)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        self.assertNotIn(t["_id"], body["data"].get("pendingTasks", []))

    def test_put_user_pendingTasks_assigns_tasks(self):
        u = self._create_user(name="BulkAssign", email=mk_email())
        t1 = self._create_task(name="B1", deadline=iso_in(3), completed=False, assignedUser="", assignedUserName="unassigned")
        t2 = self._create_task(name="B2", deadline=iso_in(4), completed=False, assignedUser="", assignedUserName="unassigned")

        # 用 PUT /users/:id 设置 pendingTasks = [t1, t2]
        new_user = {"name": u["name"], "email": u["email"], "pendingTasks":[t1["_id"], t2["_id"]]}
        r = requests.put(f"{USERS}/{u['_id']}", json=new_user, timeout=10)
        body = ensure_envelope(r); self.assertIn(r.status_code,(200,201))
        self.assertCountEqual(body["data"].get("pendingTasks", []), [t1["_id"], t2["_id"]])

        # 任务应被分配（assignedUser/assignedUserName）
        for tid in (t1["_id"], t2["_id"]):
            r = requests.get(f"{TASKS}/{tid}", timeout=10)
            b = ensure_envelope(r); self.assertEqual(r.status_code, 200)
            self.assertEqual(b["data"].get("assignedUser"), u["_id"])
            self.assertEqual(b["data"].get("assignedUserName"), u["name"])

    def test_delete_user_unassigns_their_pending_tasks(self):
        u = self._create_user(name="ToBeDeleted", email=mk_email())
        t = self._create_task(name="BoundTask", deadline=iso_in(2), completed=False)

        # 分配任务给用户
        payload = {
            "name": t["name"],
            "description": t.get("description",""),
            "deadline": t["deadline"],
            "completed": False,
            "assignedUser": u["_id"],
            "assignedUserName": u["name"]
        }
        requests.put(f"{TASKS}/{t['_id']}", json=payload, timeout=10)

        # 删除用户
        r = requests.delete(f"{USERS}/{u['_id']}", timeout=10)
        _ = ensure_envelope(r); self.assertIn(r.status_code,(200,204))
        self.created_user_ids.discard(u["_id"])

        # 任务应被自动解绑
        r = requests.get(f"{TASKS}/{t['_id']}", timeout=10)
        if r.status_code == 200:
            b = ensure_envelope(r)
            self.assertIn(b["data"].get("assignedUser",""), ("", None))
            self.assertEqual(b["data"].get("assignedUserName","unassigned"), "unassigned")

    # ============== 404 / 400 负向用例 ==============

    def test_get_nonexistent_user_returns_404(self):
        r = requests.get(f"{USERS}/000000000000000000000000", timeout=10)
        if r.status_code != 404:
            b = ensure_envelope(r)
            self.assertTrue(r.status_code == 404 or b["data"] in (None, {}, []))

    def test_put_nonexistent_task_returns_404(self):
        payload = {
            "name":"ghost","description":"",
            "deadline": iso_in(5),
            "completed": False, "assignedUser":"", "assignedUserName":"unassigned"
        }
        r = requests.put(f"{TASKS}/000000000000000000000000", json=payload, timeout=10)
        if r.status_code != 404:
            _ = ensure_envelope(r)
            self.assertEqual(r.status_code, 404)

    # ============== limit 默认值（tasks=100 / users=无限） ==============
    # 注：因为数据库规模不确定，这里做“尽力断言” + 兼容实现差异

    def test_tasks_default_limit_is_100_when_omitted(self):
        # 构造 110 个任务（若已足够则少造）
        need = max(0, 110 - len(self._list_tasks()))
        for _ in range(need):
            self._create_task(name=f"bulk-{random.randint(1000,9999)}", deadline=iso_in(7))
        # 不带 limit
        r = requests.get(TASKS, timeout=15)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        data = body["data"]
        if isinstance(data, list):
            self.assertLessEqual(len(data), 100, "Default limit for tasks should be 100")

    def test_users_default_limit_unlimited(self):
        # 造 120 个用户（如果数量不足）
        need = max(0, 120 - len(self._list_users()))
        for _ in range(need):
            self._create_user(name=f"bulkU-{random.randint(1000,9999)}", email=mk_email())
        r = requests.get(USERS, timeout=15)
        body = ensure_envelope(r); self.assertEqual(r.status_code, 200)
        data = body["data"]
        # 不能严格断定“无限”，但至少不应被 100 限制
        if isinstance(data, list):
            self.assertGreaterEqual(len(data), 101, "Users endpoint should not default-limit to 100")

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
