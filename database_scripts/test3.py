# tests/test_api_users_tasks.py
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000")
API = f"{BASE_URL}/api"

# ---------- tiny helpers ----------

def now_ms():
    return int(time.time() * 1000) + 86400000  # +1天，避免过期边界

def oid_like():
    # 24位hex，形似 ObjectId（即便后端把它当字符串）
    return uuid.uuid4().hex[:24]

def req(method, path, **kw):
    r = requests.request(method, f"{API}{path}", timeout=10, **kw)
    return r

def j(r):
    # 统一抽取 JSON payload 的 data 字段
    r.raise_for_status()  # 2xx 保证
    return r.json()["data"]

def create_user(name=None, email=None, pending=None):
    name = name or f"U-{uuid.uuid4().hex[:6]}"
    email = email or f"{uuid.uuid4().hex[:6]}@t.dev"
    payload = {"name": name, "email": email}
    if pending is not None:
        payload["pendingTasks"] = list(map(str, pending))
    r = req("POST", "/users", json=payload)
    assert r.status_code in (201, 200)
    return r.json()["data"]

def get_user(uid):
    r = req("GET", f"/users/{uid}")
    return r.json()["data"]

def delete_user(uid):
    r = req("DELETE", f"/users/{uid}")
    return r

def create_task(name=None, deadline=None, assigned_user="", assigned_user_name=None, completed=False):
    name = name or f"T-{uuid.uuid4().hex[:6]}"
    deadline = deadline if deadline is not None else now_ms()
    payload = {
        "name": name,
        # 用字符串数字测试你的 toNumberIfNumericString + Mongoose cast
        "deadline": str(deadline),
        "completed": completed,
    }
    if assigned_user is not None:
        payload["assignedUser"] = str(assigned_user or "")
    if assigned_user_name is not None:
        payload["assignedUserName"] = assigned_user_name

    r = req("POST", "/tasks", json=payload)
    assert r.status_code in (201, 200)
    return r.json()["data"]

def get_task(tid):
    r = req("GET", f"/tasks/{tid}")
    return r.json()["data"]

def delete_task(tid):
    r = req("DELETE", f"/tasks/{tid}")
    return r

def put_user(uid, body):
    return req("PUT", f"/users/{uid}", json=body)

def put_task(tid, body):
    return req("PUT", f"/tasks/{tid}", json=body)

# ---------- pytest fixtures ----------

@pytest.fixture(scope="function")
def cleanups():
    bag = {"users": [], "tasks": []}
    yield bag
    # teardown：尽量清掉，避免污染
    for t in bag["tasks"]:
        try:
            delete_task(t)
        except Exception:
            pass
    for u in bag["users"]:
        try:
            delete_user(u)
        except Exception:
            pass

# ========== 1) PUT /api/users/:id & pendingTasks ==========

def test_put_user_pendingTasks_contains_nonexistent_returns_400(cleanups):
    # 目标：pendingTasks 中任一 task 不存在 → 返回 400（按你的需求）
    u = create_user()
    cleanups["users"].append(u["_id"])

    fake_tid = oid_like()  # 不存在的任务
    body = {"name": u["name"], "email": u["email"], "pendingTasks": [fake_tid]}
    r = put_user(u["_id"], body)

    # 你的当前实现是 404（notFound "task not found"），
    # 但根据你给的测试需求，这里应为 400。
    assert r.status_code == 400, f"期望 400，但实际是 {r.status_code}，请调整路由以符合题意"

def test_put_user_pendingTasks_contains_completed_returns_400(cleanups):
    # 目标：任一 pendingTask 已完成 → 返回 400
    u = create_user()
    cleanups["users"].append(u["_id"])

    done_task = create_task(completed=True)  # 已完成
    cleanups["tasks"].append(done_task["_id"])

    body = {"name": u["name"], "email": u["email"], "pendingTasks": [done_task["_id"]]}
    r = put_user(u["_id"], body)
    assert r.status_code == 400

def test_put_user_pendingTasks_assign_unowned_task_updates_task_and_username(cleanups):
    # 目标：任务未被其他人占有 → PUT user 后，task.assignedUser=该用户 & assignedUserName=该用户名
    u = create_user()
    cleanups["users"].append(u["_id"])

    t = create_task()  # 默认 unassigned
    cleanups["tasks"].append(t["_id"])

    body = {"name": u["name"], "email": u["email"], "pendingTasks": [t["_id"]]}
    r = put_user(u["_id"], body)
    assert r.status_code == 200

    # GET task 校验
    t2 = get_task(t["_id"])
    assert t2["assignedUser"] == u["_id"]
    assert t2["assignedUserName"] == u["name"]

def test_put_user_pendingTasks_steal_from_other_user_updates_both_users_and_task(cleanups):
    # 目标：任务原本属于其他人 → PUT 我后：
    # - 其他人的 pendingTasks 被正确移除
    # - task.assignedUser/assignedUserName 改成我
    other = create_user()
    me = create_user()
    cleanups["users"] += [other["_id"], me["_id"]]

    # 先创建一个任务并分配给 other（通过创建时传递）
    t = create_task(assigned_user=other["_id"], assigned_user_name=other["name"])
    cleanups["tasks"].append(t["_id"])

    # 确保 other 这时已经把该 task 纳入 pendingTasks（创建时会同步）
    other_now = get_user(other["_id"])
    assert t["_id"] in (other_now.get("pendingTasks") or [])

    # 我把它加入我的 pendingTasks
    body = {"name": me["name"], "email": me["email"], "pendingTasks": [t["_id"]]}
    r = put_user(me["_id"], body)
    assert r.status_code == 200

    # 其他人 pendingTasks 应被移除该 task
    other_after = get_user(other["_id"])
    assert t["_id"] not in (other_after.get("pendingTasks") or [])

    # 任务应改为分配给我
    t_after = get_task(t["_id"])
    assert t_after["assignedUser"] == me["_id"]
    assert t_after["assignedUserName"] == me["name"]

    # 我自己的 pendingTasks 里有它
    me_after = get_user(me["_id"])
    assert t["_id"] in (me_after.get("pendingTasks") or [])

# ========== 2) PUT /api/tasks/:id ==========

def test_put_task_full_update_and_unassign_when_no_assignedUser(cleanups):
    # 先准备：一个用户和一个已分配给该用户的任务
    u = create_user()
    cleanups["users"].append(u["_id"])
    t = create_task(assigned_user=u["_id"], assigned_user_name=u["name"])
    cleanups["tasks"].append(t["_id"])

    # 更新任务所有字段，但不传 assignedUser => 应自动变为未指派
    new_name = "Renamed Task"
    new_desc = "New desc"
    new_deadline = now_ms() + 86400000
    body = {
        "name": new_name,
        "description": new_desc,
        "deadline": str(new_deadline),
        "completed": False
        # 不传 assignedUser / assignedUserName
    }
    r = put_task(t["_id"], body)
    assert r.status_code == 200

    # 任务应 unassigned
    t2 = get_task(t["_id"])
    assert t2["name"] == new_name
    assert t2["description"] == new_desc
    assert "assignedUser" in t2 and t2["assignedUser"] == ""
    assert "assignedUserName" in t2 and t2["assignedUserName"] == "unassigned"

    # 原来用户的 pendingTasks 应移除该任务
    u_after = get_user(u["_id"])
    assert t["_id"] not in (u_after.get("pendingTasks") or [])

def test_put_task_assign_to_new_user_updates_both_sides(cleanups):
    # 准备：task 原本分配给 u1，之后改指派给 u2
    u1 = create_user()
    u2 = create_user()
    cleanups["users"] += [u1["_id"], u2["_id"]]

    t = create_task(assigned_user=u1["_id"], assigned_user_name=u1["name"])
    cleanups["tasks"].append(t["_id"])

    # 改指派给 u2
    body = {
        "name": t["name"],
        "description": "moved to u2",
        "deadline": str(now_ms()),
        "completed": False,
        "assignedUser": u2["_id"],
        # 不传 assignedUserName，后端应自动拉取 u2.name
    }
    r = put_task(t["_id"], body)
    assert r.status_code == 200

    # 任务应分配给 u2，且 assignedUserName 自动同步为 u2.name
    t2 = get_task(t["_id"])
    assert t2["assignedUser"] == u2["_id"]
    assert t2["assignedUserName"] == u2["name"]

    # u2 pending 有该任务，u1 pending 不应再包含
    u2_after = get_user(u2["_id"])
    assert t["_id"] in (u2_after.get("pendingTasks") or [])
    u1_after = get_user(u1["_id"])
    assert t["_id"] not in (u1_after.get("pendingTasks") or [])

def test_put_task_rejects_nonexistent_assignedUser(cleanups):
    # 目标：如果传了新的 assignedUser 但该用户不存在 → 400
    t = create_task()
    cleanups["tasks"].append(t["_id"])

    body = {
        "name": t["name"],
        "description": "bad user",
        "deadline": str(now_ms()),
        "completed": False,
        "assignedUser": oid_like(),  # 不存在
    }
    r = put_task(t["_id"], body)
    assert r.status_code == 400

def test_put_task_assignedUser_and_name_must_match_else_400(cleanups):
    # 目标：若同时传 assignedUser 和 assignedUserName，姓名必须匹配 → 否则 400
    u = create_user()
    cleanups["users"].append(u["_id"])
    t = create_task()
    cleanups["tasks"].append(t["_id"])

    body = {
        "name": "x",
        "description": "y",
        "deadline": str(now_ms()),
        "completed": False,
        "assignedUser": u["_id"],
        "assignedUserName": "WRONG NAME",
    }
    r = put_task(t["_id"], body)
    assert r.status_code == 400

def test_put_task_omitted_assignedUserName_should_autofill_from_user(cleanups):
    # 目标：若传了 assignedUser 但没传 assignedUserName，后端应自动用该用户的 name
    u = create_user()
    cleanups["users"].append(u["_id"])
    t = create_task()
    cleanups["tasks"].append(t["_id"])

    body = {
        "name": "z",
        "description": "auto-name",
        "deadline": str(now_ms()),
        "completed": False,
        "assignedUser": u["_id"],
        # 不传 assignedUserName
    }
    r = put_task(t["_id"], body)
    assert r.status_code == 200

    t2 = get_task(t["_id"])
    assert t2["assignedUser"] == u["_id"]
    assert t2["assignedUserName"] == u["name"]

    # 用户 pendingTasks 也应包含该任务
    u_after = get_user(u["_id"])
    assert t["_id"] in (u_after.get("pendingTasks") or [])
