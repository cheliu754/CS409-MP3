#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CS 409 – MP #3: APIed Piper — 全覆盖测试脚本
用法:
    pip install requests
    python test_api_mp3.py --base http://localhost:3000/api

覆盖范围（逐条映射到规格/示例）：
1) 端点与状态码：
   - /users 与 /tasks：GET/POST/GET:id/PUT/DELETE
   - 成功状态码 200/201；DELETE 允许 200 或 204
   - 错误状态码 400/404，意外 500 兜底
   - 响应外壳 { message: string, data: any }（所有非 204 响应）

2) GET 查询参数（含示例）：
   - where / sort / select / skip / limit / count（users 与 tasks 都测）
   - 示例：/tasks ；/users
   - 示例：/users?where={"_id":"..."}  （按需用我们刚建的 id）
   - 示例：/tasks?where={"completed":true}
   - 示例：/tasks?where={"_id":{"$in":[id1,id2]}}
   - 示例：/users?sort={"name":1}
   - 示例：/users?select={"_id":0}
   - 示例：/tasks?skip=60&limit=20
   - 组合示例：/users?sort={"name":1}&skip=60&limit=20
   - /users/:id 与 /tasks/:id 也支持 select

3) 服务器校验：
   - User 必须有 name & email；email 唯一
   - Task 必须有 name & deadline
   - 对“assignedUser 不存在/assignedUserName 不匹配”给出宽松判定：不得返回 200/201

4) 双向引用保证（四条硬性）：
   - PUT Task(assignedUser/assignedUserName) ⇒ 两边 pendingTasks 同步迁移
   - DELETE Task ⇒ 从其 assignedUser 的 pendingTasks 移除
   - PUT User(pendingTasks) ⇒ 相应 Task 的 assignedUser/assignedUserName 同步
   - DELETE User ⇒ 其未完成任务被“解除分配”（assignedUser=""，assignedUserName="unassigned"）

5) 其他：
   - /tasks 默认 limit ≤ 100
   - /users, /tasks 的 count=true 返回整数
"""

import argparse
import json
import random
import string
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import requests


# ---------- 工具函数 ----------
def q(obj: dict) -> str:
    """把对象压缩为 JSON 字符串（用于查询参数）"""
    return json.dumps(obj, separators=(",", ":"))

def gen_tag(n=6) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))

def must_status(resp: requests.Response, expected: int | list[int]):
    if isinstance(expected, list):
        if resp.status_code not in expected:
            raise AssertionError(f"Expected {expected}, got {resp.status_code}, body={resp.text[:800]}")
    else:
        if resp.status_code != expected:
            raise AssertionError(f"Expected {expected}, got {resp.status_code}, body={resp.text[:800]}")

def parse_envelope(resp: requests.Response) -> dict:
    """DELETE 204 时可能空响应；其他情况必须是 {message,data}"""
    if resp.status_code == 204 or not resp.text.strip():
        return {"message": "", "data": None}
    try:
        j = resp.json()
    except Exception:
        raise AssertionError(f"Response not valid JSON: {resp.text[:800]}")
    if not isinstance(j, dict) or "message" not in j or "data" not in j:
        raise AssertionError(f"Missing envelope {{message,data}}: {j}")
    if not isinstance(j["message"], str):
        raise AssertionError("message must be a string")
    return j


# ---------- 测试驱动 ----------
class Tester:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.s = requests.Session()
        self.now = datetime.now(timezone.utc)
        self.tag = f"mp3-{gen_tag()}"
        self.ids: dict[str, str] = {}   # e.g. u1, u2, t1, t2...

    # ---- 简化请求包装 ----
    def POST(self, path: str, body: dict, expect=201) -> dict:
        r = self.s.post(f"{self.base}{path}", json=body)
        must_status(r, expect)
        return parse_envelope(r)

    def GET(self, path: str, params: dict | None = None, expect=200) -> dict:
        r = self.s.get(f"{self.base}{path}", params=params)
        must_status(r, expect)
        return parse_envelope(r)

    def PUT(self, path: str, body: dict, expect=200) -> dict:
        r = self.s.put(f"{self.base}{path}", json=body)
        must_status(r, expect)
        return parse_envelope(r)

    def DELETE(self, path: str, expect=[200, 204]) -> dict:
        r = self.s.delete(f"{self.base}{path}")
        must_status(r, expect)
        return parse_envelope(r)

    # ---- 具体测试 ----
    def test_create_users(self):
        # POST /users (201) & envelope
        j = self.POST("/users", {"name": f"Alice {self.tag}", "email": f"alice.{self.tag}@ex.com"})
        self.ids["u1"] = j["data"]["_id"]
        self.u1 = j["data"]
        j = self.POST("/users", {"name": f"Bob {self.tag}", "email": f"bob.{self.tag}@ex.com"})
        self.ids["u2"] = j["data"]["_id"]
        self.u2 = j["data"]
        print("[OK] POST /users x2")

    def test_user_validation(self):
        # duplicate email -> 400
        self.POST("/users", {"name": "dup", "email": self.u1["email"]}, expect=400)
        # missing name/email -> 400
        self.POST("/users", {"email": f"no-name.{self.tag}@ex.com"}, expect=400)
        self.POST("/users", {"name": "no-email"}, expect=400)
        print("[OK] User validation (required/unique)")

    def test_users_queries_and_examples(self):
        # 示例：/users (全列表)
        self.GET("/users")
        # 示例：/users?where={"_id":"..."}
        self.GET("/users", params={"where": q({"_id": self.ids["u1"]})})
        # 示例：/users?sort={"name":1}
        j = self.GET("/users", params={"sort": q({"name": 1}), "limit": 5})
        data = j["data"]
        if isinstance(data, list) and len(data) >= 2:
            names = [x.get("name") for x in data]
            assert names == sorted(names), "name asc sort failed"
        # 示例：/users?select={"_id":0}
        j = self.GET("/users", params={"select": q({"_id": 0}), "limit": 1})
        if j["data"]:
            assert "_id" not in j["data"][0], "select exclude _id failed"
        # 示例：/users?sort={"name":1}&skip=60&limit=20（不强求数量，只验证 200 与列表）
        j = self.GET("/users", params={"sort": q({"name": 1}), "skip": 60, "limit": 20})
        assert isinstance(j["data"], list), "combined query should return list"
        # count=true
        j = self.GET("/users", params={"count": "true"})
        assert isinstance(j["data"], int), "users count=true should return integer"
        print("[OK] Users queries (+ all examples)")

    def test_create_tasks(self):
        # POST /tasks (201)
        ddl = (self.now + timedelta(days=7)).isoformat()
        j = self.POST("/tasks", {
            "name": f"Task1 {self.tag}",
            "description": "d1",
            "deadline": ddl,
            "completed": False,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"]
        })
        self.ids["t1"] = j["data"]["_id"]
        self.t1 = j["data"]

        j = self.POST("/tasks", {
            "name": f"Task2 {self.tag}",
            "description": "d2",
            "deadline": (self.now + timedelta(days=10)).isoformat(),
            "completed": True,
            "assignedUser": "",
            "assignedUserName": "unassigned"
        })
        self.ids["t2"] = j["data"]["_id"]
        self.t2 = j["data"]

        j = self.POST("/tasks", {
            "name": f"Task3 {self.tag}",
            "description": "d3",
            "deadline": (self.now + timedelta(days=5)).isoformat(),
            "completed": False,
            "assignedUser": "",
            "assignedUserName": "unassigned"
        })
        self.ids["t3"] = j["data"]["_id"]
        self.t3 = j["data"]

        print("[OK] POST /tasks x3")

    def test_task_validation(self):
        # missing name / deadline -> 400
        self.POST("/tasks", {"name": f"no-deadline {self.tag}"}, expect=400)
        self.POST("/tasks", {"deadline": (self.now + timedelta(days=1)).isoformat()}, expect=400)
        print("[OK] Task validation (required fields)")

    def test_tasks_queries_and_examples(self):
        # 示例：/tasks（默认 limit ≤ 100）
        j = self.GET("/tasks")
        if isinstance(j["data"], list) and len(j["data"]) > 100:
            raise AssertionError("Default limit for /tasks should be 100 or fewer")
        # 示例：/tasks?where={"completed":true}
        j = self.GET("/tasks", params={"where": q({"completed": True})})
        assert isinstance(j["data"], list)
        # 示例：/tasks?where={"_id":{"$in":[id1,id2]}}
        j = self.GET("/tasks", params={"where": q({"_id": {"$in": [self.ids["t1"], self.ids["t2"]]}})})
        ids = {x["_id"] for x in j["data"]}
        assert self.ids["t1"] in ids and self.ids["t2"] in ids, "$in query failed to include both tasks"
        # 示例：/tasks?skip=60&limit=20（不强求数量，只验证 200 与列表）
        j = self.GET("/tasks", params={"skip": 60, "limit": 20})
        assert isinstance(j["data"], list)
        # count=true
        j = self.GET("/tasks", params={"count": "true"})
        assert isinstance(j["data"], int), "tasks count=true should return integer"
        print("[OK] Tasks queries (+ all examples)")

    def test_get_id_and_select(self):
        # /users/:id with select
        j = self.GET(f"/users/{self.ids['u1']}", params={"select": q({"email": 0})})
        assert "email" not in j["data"], "select exclusion not applied for /users/:id"
        # /tasks/:id with select
        j = self.GET(f"/tasks/{self.ids['t1']}", params={"select": q({"description": 0})})
        assert "description" not in j["data"], "select exclusion not applied for /tasks/:id"
        print("[OK] GET :id supports select")

    def test_404s(self):
        bogus = "000000000000000000000000"
        self.GET(f"/users/{bogus}", expect=404)
        self.GET(f"/tasks/{bogus}", expect=404)
        self.PUT(f"/users/{bogus}", {"name": "X", "email": f"x-{self.tag}@ex.com", "pendingTasks": []}, expect=404)
        self.PUT(f"/tasks/{bogus}", {"name": "X", "deadline": self.now.isoformat()}, expect=404)
        self.DELETE(f"/users/{bogus}", expect=404)
        self.DELETE(f"/tasks/{bogus}", expect=404)
        print("[OK] 404 checks for non-existent ids")

    def test_assignment_two_way(self):
        # 创建 t4：先给 u1
        j = self.POST("/tasks", {
            "name": f"Task4 {self.tag}",
            "description": "d4",
            "deadline": (self.now + timedelta(days=3)).isoformat(),
            "completed": False,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"],
        })
        self.ids["t4"] = j["data"]["_id"]

        # -> 验证已进 u1.pendingTasks
        j = self.GET(f"/users/{self.ids['u1']}")
        assert self.ids["t4"] in j["data"]["pendingTasks"], "t4 not in u1.pendingTasks after creation"

        # PUT /tasks：把 t4 从 u1 -> u2
        j = self.PUT(f"/tasks/{self.ids['t4']}", {
            "name": f"Task4 {self.tag}",
            "description": "d4",
            "deadline": (self.now + timedelta(days=3)).isoformat(),
            "completed": False,
            "assignedUser": self.ids["u2"],
            "assignedUserName": self.u2["name"],
        })
        # -> u1 不再有 t4；u2 拥有 t4
        j = self.GET(f"/users/{self.ids['u1']}")
        assert self.ids["t4"] not in j["data"]["pendingTasks"], "t4 still in u1 after reassignment"
        j = self.GET(f"/users/{self.ids['u2']}")
        assert self.ids["t4"] in j["data"]["pendingTasks"], "t4 not in u2 after reassignment"
        print("[OK] PUT /tasks keeps two-way pendingTasks in sync")

    def test_put_user_pendingtasks(self):
        # 准备一条未分配任务 t5
        j = self.POST("/tasks", {
            "name": f"Task5 {self.tag}",
            "description": "d5",
            "deadline": (self.now + timedelta(days=8)).isoformat(),
            "completed": False,
            "assignedUser": "",
            "assignedUserName": "unassigned",
        })
        self.ids["t5"] = j["data"]["_id"]

        # GET u2 的当前 pendingTasks，加入 t5 后 PUT 回去
        j = self.GET(f"/users/{self.ids['u2']}")
        pt = set(j["data"].get("pendingTasks", []))
        pt.add(self.ids["t5"])
        self.PUT(f"/users/{self.ids['u2']}", {
            "name": self.u2["name"],
            "email": self.u2["email"],
            "pendingTasks": list(pt)
        })

        # 验证 t5 已被分配给 u2（assignedUser & assignedUserName）
        j = self.GET(f"/tasks/{self.ids['t5']}")
        assert j["data"]["assignedUser"] == self.ids["u2"], "PUT /users failed to assign task.assignedUser"
        assert j["data"]["assignedUserName"] == self.u2["name"], "PUT /users failed to set task.assignedUserName"
        print("[OK] PUT /users with pendingTasks syncs tasks' assignment")

    def test_delete_task_cleanup(self):
        # 删除 t5，应从 u2.pendingTasks 移除
        self.DELETE(f"/tasks/{self.ids['t5']}")
        j = self.GET(f"/users/{self.ids['u2']}")
        assert self.ids["t5"] not in j["data"].get("pendingTasks", []), "DELETE /tasks didn't clean pendingTasks"
        print("[OK] DELETE /tasks cleans up user's pendingTasks")

    def test_delete_user_unassigns_tasks(self):
        # 创建 t6 分配给 u2（未完成）
        j = self.POST("/tasks", {
            "name": f"Task6 {self.tag}",
            "description": "d6",
            "deadline": (self.now + timedelta(days=4)).isoformat(),
            "completed": False,
            "assignedUser": self.ids["u2"],
            "assignedUserName": self.u2["name"]
        })
        self.ids["t6"] = j["data"]["_id"]

        # 删除 u2
        self.DELETE(f"/users/{self.ids['u2']}")
        # 验证 t6 解除分配
        j = self.GET(f"/tasks/{self.ids['t6']}")
        assert j["data"]["assignedUser"] in ("", None), "Task should be unassigned after DELETE /users"
        assert j["data"]["assignedUserName"] == "unassigned", "assignedUserName should be 'unassigned'"
        print("[OK] DELETE /users unassigns their pending tasks")

    def test_optional_completed_drop_from_pending(self):
        # 可选：完成任务是否从 pendingTasks 移除（不强制，只给提醒）
        j = self.POST("/tasks", {
            "name": f"Task7 {self.tag}",
            "description": "d7",
            "deadline": (self.now + timedelta(days=2)).isoformat(),
            "completed": False,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"]
        })
        self.ids["t7"] = j["data"]["_id"]
        # 标记完成
        self.PUT(f"/tasks/{self.ids['t7']}", {
            "name": f"Task7 {self.tag}",
            "description": "d7",
            "deadline": (self.now + timedelta(days=2)).isoformat(),
            "completed": True,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"]
        })
        j = self.GET(f"/users/{self.ids['u1']}")
        if self.ids["t7"] in j["data"].get("pendingTasks", []):
            print("[WARN] Completed task still in pendingTasks (implementation-specific; not failing).")
        else:
            print("[OK] Completed task removed from pendingTasks (good)")

    def test_put_user_name_updates_assignedUserName_warn(self):
        # 先建一条分配给 u1 的 t8
        j = self.POST("/tasks", {
            "name": f"Task8 {self.tag}",
            "description": "d8",
            "deadline": (self.now + timedelta(days=6)).isoformat(),
            "completed": False,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"]
        })
        self.ids["t8"] = j["data"]["_id"]

        new_name = f"AliceRenamed {self.tag}"

        # ✅ 改名时不传 pendingTasks，避免把任务清空导致无法同步
        self.PUT(f"/users/{self.ids['u1']}", {
            "name": new_name,
            "email": self.u1["email"]
        })

        # 检查任务名字是否同步
        jtask = self.GET(f"/tasks/{self.ids['t8']}")
        if jtask["data"]["assignedUserName"] != new_name:
            print("[WARN] User rename did not propagate to task.assignedUserName (instructors recommend syncing).")
        else:
            print("[OK] User rename propagated to tasks (nice)")

    def test_bad_assignment_inputs(self):
        # 尝试创建/更新任务时，assignedUser 使用不存在的 id；或与 assignedUserName 明显不一致
        bogus = "000000000000000000000123"
        # 创建时
        r = self.s.post(f"{self.base}/tasks", json={
            "name": f"TaskBad {self.tag}",
            "description": "bad",
            "deadline": (self.now + timedelta(days=1)).isoformat(),
            "completed": False,
            "assignedUser": bogus,
            "assignedUserName": "should-not-exist"
        })
        if r.status_code in (200, 201):
            raise AssertionError("Creating task with non-existent assignedUser should NOT return 200/201")
        # 更新时
        r = self.s.put(f"{self.base}/tasks/{self.ids['t1']}", json={
            "name": self.t1["name"],
            "description": self.t1.get("description", ""),
            "deadline": self.t1["deadline"],
            "completed": False,
            "assignedUser": bogus,
            "assignedUserName": "nope"
        })
        if r.status_code in (200, 201):
            raise AssertionError("Updating task with non-existent assignedUser should NOT return 200/201")
        print("[OK] Bad assignment inputs rejected (status not 200/201)")
        
    def test_completed_task_update_forbidden(self):
        # 建一条任务，先完成它
        j = self.POST("/tasks", {
            "name": f"TaskC {self.tag}",
            "description": "done",
            "deadline": (self.now + timedelta(days=2)).isoformat(),
            "completed": False,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"]
        })
        tid = j["data"]["_id"]

        # 标记完成
        self.PUT(f"/tasks/{tid}", {
            "name": j["data"]["name"],
            "description": j["data"]["description"],
            "deadline": j["data"]["deadline"],
            "completed": True,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"]
        })

        # 尝试再修改（哪怕只是描述），应 400
        r = self.s.put(f"{self.base}/tasks/{tid}", json={
            "name": j["data"]["name"],
            "description": "should-fail",
            "deadline": j["data"]["deadline"],
            "completed": True,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"]
        })
        if r.status_code == 200:
            raise AssertionError("PUT on a completed task should return 400 per instructor clarification")
        print("[OK] Completed task cannot be updated (PUT returns error)")

    def test_cannot_add_completed_task_to_pending(self):
        # 创建一个已完成的任务
        j = self.POST("/tasks", {
            "name": f"TaskDone {self.tag}",
            "description": "done",
            "deadline": (self.now + timedelta(days=1)).isoformat(),
            "completed": True,
            "assignedUser": "",
            "assignedUserName": "unassigned"
        })
        done_id = j["data"]["_id"]

        # 取 u1 当前 pendingTasks
        juser = self.GET(f"/users/{self.ids['u1']}")
        pt = set(juser["data"].get("pendingTasks", []))
        pt.add(done_id)  # 企图加入已完成任务

        # 发送 PUT，期望 400
        r = self.s.put(f"{self.base}/users/{self.ids['u1']}", json={
            "name": juser["data"]["name"],
            "email": juser["data"]["email"],
            "pendingTasks": list(pt)
        })
        if r.status_code == 200:
            raise AssertionError("Should not be able to add a completed task to user's pendingTasks (expect 400)")
        print("[OK] Cannot add completed task to pendingTasks")
        
    def test_optional_completed_drop_from_pending(self):
        j = self.POST("/tasks", {
            "name": f"Task7 {self.tag}",
            "description": "d7",
            "deadline": (self.now + timedelta(days=2)).isoformat(),
            "completed": False,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"]
        })
        self.ids["t7"] = j["data"]["_id"]

        # 标记完成
        self.PUT(f"/tasks/{self.ids['t7']}", {
            "name": f"Task7 {self.tag}",
            "description": "d7",
            "deadline": (self.now + timedelta(days=2)).isoformat(),
            "completed": True,
            "assignedUser": self.ids["u1"],
            "assignedUserName": self.u1["name"]
        })

        # ✅ 仍然保持分配（不 unassign）
        jtask = self.GET(f"/tasks/{self.ids['t7']}")
        assert jtask["data"]["assignedUser"] == self.ids["u1"], "Completed task should not be unassigned"

        # ✅ 但从 pendingTasks 移除
        j = self.GET(f"/users/{self.ids['u1']}")
        if self.ids["t7"] in j["data"].get("pendingTasks", []):
            print("[WARN] Completed task still in pendingTasks (implementation-specific; not failing).")
        else:
            print("[OK] Completed task removed from pendingTasks (good)")
            
    def test_users_six_params_combo(self):
        made_ids = []
        base_names = [f"U-{i:02d} {self.tag}" for i in range(6)]
        for nm in base_names:
            j = self.POST("/users", {"name": nm, "email": f"{nm.replace(' ','.')}@ex.com"})
            made_ids.append(j["data"]["_id"])

        expected_sorted_names = sorted(base_names)

        # ✅ 仅匹配 6 个受控用户（避免 Alice/Bob 干扰）
        where = {"_id": {"$in": made_ids}}

        # count 应该是 6
        j_count = self.GET("/users", params={"where": q(where), "count": "true"})
        assert j_count["data"] == 6, f"users count mismatch, got {j_count['data']}"

        # 全量（足够大的 limit）检验排序
        j_all = self.GET("/users", params={"where": q(where), "sort": q({"name": 1}), "limit": 1000})
        names_all = [u["name"] for u in j_all["data"]]
        assert names_all == expected_sorted_names, "users sort by name asc mismatch"

        # 切片：skip=2, limit=3 => 期望 U-02..U-04
        j_slice = self.GET(
            "/users",
            params={
                "where": q(where),
                "sort": q({"name": 1}),
                "select": q({"email": 0}),
                "skip": 2,
                "limit": 3,
            },
        )
        slice_names = [u["name"] for u in j_slice["data"]]
        assert slice_names == expected_sorted_names[2:5], "users skip/limit slice incorrect"
        if j_slice["data"]:
            assert "email" not in j_slice["data"][0], "users select exclusion failed (email present)"

        print("[OK] Users six-params combo (where/sort/select/skip/limit/count)")


    def test_tasks_six_params_combo(self):
        """
        同时使用 where + sort + select + skip + limit + count：
        - 构造 6 个受控任务 T-00..T-05，completed 交替 True/False，名字含 tag，未指派
        - where：name 正则匹配 tag 且 completed=false（只取我们控制的未完成任务）
        - sort：按 name 升序
        - select：排除 description
        - skip/limit：切片校验
        - count=true：数量一致
        - 另外再检查一次默认 limit（<=100）不被破坏
        """
        # 造 6 个受控任务（名字含 tag，完成状态交替）
        made = []
        for i in range(6):
            nm = f"Task-T-{i:02d} {self.tag}"
            j = self.POST("/tasks", {
                "name": nm,
                "description": f"D{i}",
                "deadline": (self.now + timedelta(days=30+i)).isoformat(),
                "completed": (i % 2 == 1),       # 奇数完成，偶数未完成
                "assignedUser": "",
                "assignedUserName": "unassigned"
            })
            made.append(j["data"])

        # 我们只挑未完成的那 3 个（i=0,2,4）
        all_names = [t["name"] for t in made]
        expected_unfinished = sorted([f"Task-T-{i:02d} {self.tag}" for i in range(0,6,2)])  # 0,2,4

        # where：限定 name 含 tag 且 completed=false
        where = {"name": {"$regex": self.tag}, "completed": False}

        # count=true：应该至少 3（如果库里有别的同 tag 未完成任务，也可能更多）
        j_count = self.GET("/tasks", params={"where": q(where), "count": "true"})
        assert isinstance(j_count["data"], int), "tasks count must be integer"
        assert j_count["data"] >= 3, "tasks count under where should be at least 3 on controlled dataset"

        # 拉全量（足够大的 limit），只取我们造的 3 个未完成
        j_all = self.GET("/tasks", params={"where": q(where), "sort": q({"name": 1}), "limit": 1000})
        names_all = [t["name"] for t in j_all["data"] if t["name"] in all_names]
        # 过滤只保留未完成的那三条
        names_all = [n for n in names_all if any(n == x for x in expected_unfinished)]
        assert names_all == expected_unfinished, "tasks sort by name asc mismatch on controlled dataset"

        # 切片：skip=1, limit=1 => 期望只拿到 expected_unfinished[1]
        j_slice = self.GET(
            "/tasks",
            params={
                "where": q(where),
                "sort": q({"name": 1}),
                "select": q({"description": 0}),
                "skip": 1,
                "limit": 1,
            },
        )
        slice_names = [t["name"] for t in j_slice["data"] if t["name"] in expected_unfinished]
        assert slice_names == [expected_unfinished[1]], "tasks skip/limit slice incorrect"
        if j_slice["data"]:
            assert "description" not in j_slice["data"][0], "tasks select exclusion failed (description present)"

        # 兜底：默认 limit 仍应 <= 100
        j_default = self.GET("/tasks")
        if isinstance(j_default["data"], list):
            assert len(j_default["data"]) <= 100, "tasks default limit should be <= 100"

        print("[OK] Tasks six-params combo (where/sort/select/skip/limit/count)")

    
    def test_get_lists_again(self):
        # 示例：/tasks 与 /users 再各拉一次（收尾）
        self.GET("/tasks")
        self.GET("/users")
        print("[OK] Final list endpoints reachable")

    # 运行所有测试（按逻辑顺序）
    def run_all(self):
        # 基础：创建与查询
        self.test_create_users()
        self.test_user_validation()
        self.test_users_queries_and_examples()

        self.test_create_tasks()
        self.test_task_validation()
        self.test_tasks_queries_and_examples()

        # ✅ 六参数联动：放在这里最稳
        self.test_users_six_params_combo()
        self.test_tasks_six_params_combo()

        self.test_get_id_and_select()
        self.test_404s()

        # 双向引用
        self.test_assignment_two_way()
        self.test_put_user_pendingtasks()
        self.test_delete_task_cleanup()

        # 老师澄清的硬性规则
        self.test_completed_task_update_forbidden()
        self.test_cannot_add_completed_task_to_pending()

        # 完成后的行为 & 改名同步
        self.test_optional_completed_drop_from_pending()
        self.test_put_user_name_updates_assignedUserName_warn()

        # 坏输入防御
        self.test_bad_assignment_inputs()

        # 删除用户（最后执行，避免影响前面的用例）
        self.test_delete_user_unassigns_tasks()

        # 收尾
        self.test_get_lists_again()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3000/api", help="API base URL (no trailing slash)")
    args = ap.parse_args()
    print(f"[RUN] base={args.base}")
    t = Tester(args.base)
    t.run_all()
    print(f"\n✅ ALL SPEC & EXAMPLE QUERIES COVERED. tag={t.tag}")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("\n❌ TEST FAILED:", e)
        sys.exit(1)
    except requests.RequestException as e:
        print("\n❌ NETWORK/REQUEST ERROR:", e)
        sys.exit(2)
    except Exception as e:
        print("\n❌ UNEXPECTED ERROR:", type(e).__name__, e)
        sys.exit(3)
