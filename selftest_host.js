"use strict";
/**
 * 主持页匿名合辑勾选的前端回归自测（不依赖浏览器与运行中的服务）：
 * 用最小 DOM 模拟在 Node 的 vm 中加载 static/host.js，验证 3 秒轮询不再清空勾选，
 * 且封存确认后任何响应交错都不能解除只读。
 *
 * 覆盖：
 * - 重复轮询：勾选在多次轮询重绘后保留，且各人授权状态仍随轮询更新；
 * - 取消勾选：取消的结果同样被保留，不会被轮询恢复成勾选；
 * - 勾选后跨轮询发布：提交勾选姓名，而不是提示未选成员；
 * - 授权撤回：只更新该成员的授权显示，不静默缩减所选名单；发布仍提交该姓名，
 *   由服务端整次 409 拒绝并显示原因，失败后保留勾选供调整重试；
 * - 空名单：提示且不发请求；
 * - 发布成功：按页面名单顺序提交勾选姓名，成功后显示公开链接并停止编辑；
 * - 只读转换：会话封存后勾选框与发布按钮均禁用，已发合辑只显示公开链接；
 * - 交错一（迟到的旧轮询）：会话已公布且尚无合辑时，较新轮询已返回 closed=true，
 *   迟到的 closed=false 旧响应（含封存后的网络失败）不得撤销封存提示或启用合辑控件；
 * - 交错二（发布等待期间封存）：合辑发布请求在途时轮询显示封存，随后收到服务端拒绝
 *   （或网络失败）不得重新启用发布按钮；
 * - 封存后 3 秒轮询仍按较新快照更新授权与会话信息（只是不能解除封存）；
 * - 未封存时发布失败（含网络失败）显示原因、保留勾选并恢复按钮供调整重试。
 *
 * 运行：node selftest_host.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HOST_JS = fs.readFileSync(path.join(__dirname, "static", "host.js"), "utf8");

// host.js 运行期间会按 id 取用的全部元素
const ELEMENT_IDS = [
  "error", "publish", "content", "fatal",
  "published-banner", "closed-banner", "close-section",
  "pending-summary", "ack-head", "ack-note", "reviewers",
  "reports-section", "reports", "report-decision-error",
  "anthology-section", "anthology-form", "anthology-done",
  "anthology-members", "anthology-publish", "anthology-link", "anthology-error",
  "links", "rotate-error", "remove-error",
  "close-session", "close-error",
];

class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = "";
    this.className = "";
    this.textContent = "";
    this.href = "";
    this._listeners = Object.create(null);
    this._innerHTML = "";
  }

  set innerHTML(v) {
    this._innerHTML = v;
    this.children = []; // 模拟重绘：清空子节点
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }

  dispatch(type, extra) {
    const event = Object.assign({ target: this }, extra);
    for (const fn of this._listeners[type] || []) fn(event);
  }

  closest() {
    return null;
  }
}

// 等待 host.js 中的异步 refresh/点击处理链全部落定
async function flush() {
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
}

function hostState(overrides = {}) {
  const base = {
    published: true,
    closed: false,
    can_publish: false,
    reviewers: [
      { name: "甲", submitted: true, acknowledged: false, acknowledged_at: null, anthology_consent: true },
      { name: "乙", submitted: true, acknowledged: false, acknowledged_at: null, anthology_consent: false },
      { name: "丙", submitted: true, acknowledged: false, acknowledged_at: null, anthology_consent: true },
    ],
    reports: [],
    anthology_url: null,
    links: ["甲", "乙", "丙"].map((n, i) => ({ name: n, url: "/p/t" + (i + 1) })),
  };
  return Object.assign(base, overrides);
}

// 可控响应的页面环境：
// - GET（状态轮询）默认挂起，由测试调用 pollGet() 手动解决/拒绝，从而精确控制
//   "较早发起的请求较晚返回"这类交错；
// - POST（发布合辑、封存等）同样挂起，由 resolveNextPost()/rejectNextPost() 控制。
// pendingGets/pendingPosts 里每项为 { url, resolve, reject }。
function createPage() {
  const elements = {};
  for (const id of ELEMENT_IDS) elements[id] = new El("div");
  const env = {
    elements,
    fetchCalls: [],
    pendingGets: [],
    pendingPosts: [],
    confirmResult: true,
    poll: null,
  };
  const document = {
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => new El(tag),
  };
  const sandbox = {
    document,
    location: { pathname: "/h/hosttok", origin: "http://localhost:8000" },
    fetch: (url, opts) => {
      const method = (opts && opts.method) || "GET";
      env.fetchCalls.push({
        url,
        method,
        body: opts && opts.body ? JSON.parse(opts.body) : undefined,
      });
      return new Promise((resolve, reject) => {
        const pending = { url, resolve, reject };
        if (method === "GET") env.pendingGets.push(pending);
        else env.pendingPosts.push(pending);
      });
    },
    confirm: () => env.confirmResult,
    alert: () => {},
    setInterval: (cb) => {
      env.poll = cb;
      return 1;
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(HOST_JS, sandbox, { filename: "host.js" });
  return env;
}

// ---------------- 响应控制 ----------------

// 解决一个挂起的 GET（默认解决最新发起的，即"本次"轮询；较早挂起的旧请求可稍后再解决）
function resolveGet(env, resp, index = -1) {
  const n = env.pendingGets.length;
  if (index < 0) index = n + index;
  assert.ok(index >= 0 && index < n, "应有挂起的状态请求（GET）");
  const [item] = env.pendingGets.splice(index, 1);
  item.resolve(
    resp || { ok: true, json: async () => env.curState }
  );
  return item;
}

function rejectGet(env, error) {
  const item = env.pendingGets.shift();
  assert.ok(item, "应有挂起的状态请求（GET）");
  item.reject(error || new Error("network"));
  return item;
}

function jsonResponse(resp) {
  return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, json: async () => resp.body };
}

function resolveNextPost(env, status, body) {
  const item = env.pendingPosts.shift();
  assert.ok(item, "应有挂起的写请求（POST）");
  item.resolve(jsonResponse({ status, body }));
  return item;
}

function rejectNextPost(env, error) {
  const item = env.pendingPosts.shift();
  assert.ok(item, "应有挂起的写请求（POST）");
  item.reject(error || new Error("network"));
  return item;
}

// ---------------- 页面操作辅助 ----------------

function rows(env) {
  return env.elements["anthology-members"].children;
}

function checkbox(env, name) {
  for (const tr of rows(env)) {
    const cb = tr.children[0].children[0];
    if (cb.value === name) return cb;
  }
  return null;
}

function checkedNames(env) {
  return rows(env)
    .map((tr) => tr.children[0].children[0])
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
}

function consentText(env, name) {
  for (const tr of rows(env)) {
    if (tr.children[1].textContent === name) return tr.children[2].textContent;
  }
  return null;
}

async function setChecked(env, name, on) {
  const cb = checkbox(env, name);
  assert.ok(cb, `应存在「${name}」的勾选框`);
  cb.checked = on;
  cb.dispatch("change");
  await flush();
}

// 触发一次 3 秒轮询：先发请求（挂起），再由测试决定响应时机
function startPoll(env) {
  assert.ok(env.poll, "页面应已注册轮询");
  env.poll();
}

async function settle(env) {
  await flush();
}

// 触发轮询并用给定状态立即解决（普通按序轮询）
async function poll(env, state) {
  if (state) env.curState = state;
  startPoll(env);
  await settle(env);
  resolveGet(env);
  await settle(env);
}

async function clickPublish(env) {
  env.elements["anthology-publish"].dispatch("click");
  await settle(env);
}

async function clickClose(env) {
  env.elements["close-session"].dispatch("click");
  await settle(env);
}

function posts(env) {
  return env.fetchCalls.filter((c) => c.method === "POST");
}

// 封存只读态的界面断言：封存提示显示、封存入口隐藏、公布/合辑/换发控件禁用
async function assertClosedUI(env, message) {
  const m = message || "已确认封存后应保持封存只读";
  assert.equal(env.elements["closed-banner"].hidden, false, m + "（封存提示）");
  assert.equal(env.elements["close-section"].hidden, true, m + "（封存入口隐藏）");
  assert.equal(env.elements["publish"].disabled, true, m + "（公布按钮禁用）");
  assert.equal(env.elements["anthology-publish"].disabled, true, m + "（合辑发布按钮禁用）");
  const form = env.elements["anthology-form"];
  // 已发布合辑后表单隐藏，不再有勾选框
  if (!form.hidden) {
    const cbs = rows(env).map((tr) => tr.children[0].children[0]);
    assert.ok(cbs.length > 0 && cbs.every((cb) => cb.disabled), m + "（勾选框全部禁用）");
  }
  for (const tr of env.elements["links"].children) {
    const btns = tr.children[2].children;
    for (const b of btns) {
      if (b.textContent === "换发链接") assert.equal(b.disabled, true, m + "（换发链接禁用）");
    }
  }
}

// ---------------- 用例 ----------------

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("重复轮询保留勾选，且各人授权状态仍随轮询更新", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env);
  await settle(env);
  await setChecked(env, "甲", true);
  await setChecked(env, "丙", true);
  assert.deepEqual(checkedNames(env), ["甲", "丙"]);
  // 多次 3 秒轮询：勾选不丢
  await poll(env);
  await poll(env);
  assert.deepEqual(checkedNames(env), ["甲", "丙"], "重复轮询不得清空勾选");
  // 轮询仍更新各人授权：乙授权后下一次轮询显示已授权
  const s = hostState();
  s.reviewers[1].anthology_consent = true;
  await poll(env, s);
  assert.equal(consentText(env, "乙"), "已授权");
  assert.deepEqual(checkedNames(env), ["甲", "丙"], "授权变化不得改动勾选");
});

test("取消勾选的结果同样被轮询保留", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env);
  await settle(env);
  await setChecked(env, "甲", true);
  await setChecked(env, "丙", true);
  await poll(env);
  // 取消 甲：随后的轮询不得把它恢复成勾选
  await setChecked(env, "甲", false);
  await poll(env);
  await poll(env);
  assert.deepEqual(checkedNames(env), ["丙"], "取消勾选不得被轮询恢复");
});

test("勾选后跨轮询点击发布：提交勾选姓名而非提示未选成员", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env);
  await settle(env);
  await setChecked(env, "甲", true);
  await setChecked(env, "乙", true);
  await poll(env); // 关键路径：勾选后经历一次 3 秒轮询再发布
  await clickPublish(env);
  resolveNextPost(env, 200, { ok: true, url: "/a/pub1" });
  await settle(env);
  env.curState = hostState({ anthology_url: "/a/pub1" });
  resolveGet(env); // 成功后的 refresh
  await settle(env);
  assert.equal(env.elements["anthology-error"].textContent, "", "不得提示未选成员");
  assert.equal(posts(env).length, 1, "应发出一次发布请求");
  assert.equal(posts(env)[0].url, "/api/h/hosttok/anthology");
  assert.deepEqual(posts(env)[0].body, { names: ["甲", "乙"] });
});

test("发布按页面名单顺序提交（与勾选先后无关）", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env);
  await settle(env);
  // 先勾 丙 再勾 甲：提交顺序仍按页面名单顺序（甲在丙前）
  await setChecked(env, "丙", true);
  await setChecked(env, "甲", true);
  await poll(env);
  await clickPublish(env);
  resolveNextPost(env, 200, { ok: true, url: "/a/pub2" });
  await settle(env);
  env.curState = hostState({ anthology_url: "/a/pub2" });
  resolveGet(env);
  await settle(env);
  assert.equal(posts(env).length, 1);
  assert.deepEqual(posts(env)[0].body, { names: ["甲", "丙"] }, "按页面名单顺序提交");
});

test("成员撤回授权不静默缩减所选名单；整次失败后保留勾选可重试", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env);
  await settle(env);
  await setChecked(env, "甲", true);
  await setChecked(env, "丙", true);
  // 丙撤回授权：下一次轮询显示未授权，但勾选不被静默移除
  const s = hostState();
  s.reviewers[2].anthology_consent = false;
  await poll(env, s);
  assert.equal(consentText(env, "丙"), "未授权");
  assert.deepEqual(checkedNames(env), ["甲", "丙"], "撤回授权不得静默缩减所选名单");
  // 发布仍提交丙，由服务端整次拒绝并显示原因（未封存：按钮恢复可重试）
  await clickPublish(env);
  resolveNextPost(env, 409, {
    error: "有入选稿件未获授权，整次发布已取消",
    missing_consent: ["丙"],
  });
  await settle(env);
  assert.equal(posts(env).length, 1);
  assert.deepEqual(posts(env)[0].body, { names: ["甲", "丙"] });
  assert.ok(
    env.elements["anthology-error"].textContent.includes("未授权：丙"),
    "应显示服务端返回的未授权原因"
  );
  // 失败后保留勾选、按钮恢复可用，供调整重试
  assert.deepEqual(checkedNames(env), ["甲", "丙"], "失败后保留选择");
  assert.equal(env.elements["anthology-publish"].disabled, false, "未封存失败后按钮应恢复");
  // 丙重新授权后按原名单重试成功：显示公开链接并停止编辑
  await clickPublish(env);
  resolveNextPost(env, 200, { ok: true, url: "/a/pub3" });
  await settle(env);
  env.curState = hostState({ anthology_url: "/a/pub3" });
  resolveGet(env);
  await settle(env);
  assert.equal(posts(env).length, 2);
  assert.deepEqual(posts(env)[1].body, { names: ["甲", "丙"] }, "重试仍按原勾选提交");
  assert.equal(env.elements["anthology-form"].hidden, true, "发布后停止编辑");
  assert.equal(env.elements["anthology-done"].hidden, false);
  assert.equal(
    env.elements["anthology-link"].textContent,
    "http://localhost:8000/a/pub3"
  );
});

test("未封存时发布网络失败：显示原因、保留勾选并恢复按钮，可重试成功", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env);
  await settle(env);
  await setChecked(env, "甲", true);
  await clickPublish(env);
  rejectNextPost(env); // 网络失败（会话仍未封存）
  await settle(env);
  assert.equal(posts(env).length, 1);
  assert.equal(env.elements["anthology-error"].textContent, "网络错误，请重试");
  assert.deepEqual(checkedNames(env), ["甲"], "网络失败后保留勾选供调整重试");
  assert.equal(env.elements["anthology-publish"].disabled, false, "未封存网络失败后按钮应恢复");
  // 重试成功
  await clickPublish(env);
  resolveNextPost(env, 200, { ok: true, url: "/a/retry1" });
  await settle(env);
  env.curState = hostState({ anthology_url: "/a/retry1" });
  resolveGet(env);
  await settle(env);
  assert.equal(posts(env).length, 2);
  assert.equal(env.elements["anthology-form"].hidden, true);
  assert.equal(env.elements["anthology-link"].textContent, "http://localhost:8000/a/retry1");
});

test("空名单提示且不发请求", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env);
  await settle(env);
  await clickPublish(env);
  assert.equal(env.elements["anthology-error"].textContent, "请至少选择一名成员。");
  assert.equal(posts(env).length, 0, "空名单不得发请求");
  // 勾选再全部取消后同样提示且不发请求
  await setChecked(env, "甲", true);
  await setChecked(env, "甲", false);
  await poll(env);
  await clickPublish(env);
  assert.equal(env.elements["anthology-error"].textContent, "请至少选择一名成员。");
  assert.equal(posts(env).length, 0);
});

test("会话封存后禁用选择与发布（只读转换）", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env);
  await settle(env);
  await setChecked(env, "甲", true);
  await poll(env, hostState({ closed: true }));
  const cbs = rows(env).map((tr) => tr.children[0].children[0]);
  assert.equal(cbs.length, 3);
  assert.ok(cbs.every((cb) => cb.disabled), "封存后勾选框全部禁用");
  assert.equal(env.elements["anthology-publish"].disabled, true, "封存后发布按钮禁用");
  // 已发合辑且封存：只显示公开链接（只读），不再显示选择表单
  await poll(env, hostState({ closed: true, anthology_url: "/a/readonly1" }));
  assert.equal(env.elements["anthology-form"].hidden, true);
  assert.equal(env.elements["anthology-done"].hidden, false);
  assert.equal(
    env.elements["anthology-link"].textContent,
    "http://localhost:8000/a/readonly1"
  );
});

test("交错一：较新轮询 closed=true 后，迟到的 closed=false 旧响应不得解除封存", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env); // 首屏
  await settle(env);
  await setChecked(env, "甲", true);

  // 较早发起的旧轮询（此时会话尚未封存）先挂起不返回
  startPoll(env);
  assert.equal(env.pendingGets.length, 1, "旧轮询请求应已挂起");

  // 一次更新的轮询先行返回 closed=true（封存已在服务端确认；尚无合辑）
  await poll(env, hostState({ closed: true }));
  await assertClosedUI(env, "较新轮询返回 closed=true 后应进入封存只读");

  // 迟到的旧轮询这才返回 closed=false：整份旧快照必须作废，界面维持封存只读
  resolveGet(env, {
    ok: true,
    json: async () => hostState({ closed: false }),
  });
  await settle(env);
  await assertClosedUI(env, "迟到的 closed=false 旧响应不得解除封存");
  assert.deepEqual(checkedNames(env), ["甲"], "封存不改动勾选结果");

  // 封存后的轮询若遇到网络失败：同样不得撤销封存提示或启用控件
  startPoll(env);
  rejectGet(env);
  await settle(env);
  await assertClosedUI(env, "封存后的网络失败不得解除封存");

  // 3 秒轮询仍在进行，较新快照照常更新授权与会话信息（只是 closed 恒为真）：
  // 乙在封存前完成的授权随封存后的一次成功轮询显示出来
  const s = hostState({ closed: true });
  s.reviewers[1].anthology_consent = true;
  await poll(env, s);
  assert.equal(consentText(env, "乙"), "已授权", "封存后轮询仍更新授权状态");
  await assertClosedUI(env, "更新授权后仍保持封存只读");
});

test("交错二：发布等待期间已显示封存，随后的拒绝或网络失败不得启用发布按钮", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env); // 首屏（已公布、未封存、无合辑）
  await settle(env);
  await setChecked(env, "甲", true);
  await setChecked(env, "丙", true);

  // 合辑发布请求发出并在途等待
  await clickPublish(env);
  assert.equal(env.pendingPosts.length, 1, "发布请求应在途等待");
  assert.equal(env.elements["anthology-publish"].disabled, true, "请求在途时按钮禁用");

  // 等待期间一次轮询返回 closed=true：封存被另一操作确认
  await poll(env, hostState({ closed: true }));
  await assertClosedUI(env, "等待发布期间轮询显示封存后应进入只读");
  // 勾选仍保留，只是全部禁用
  assert.deepEqual(checkedNames(env), ["甲", "丙"], "封存不清空勾选");

  // 服务端随后对这次发布给出封存拒绝（409）：显示原因，但不得重新启用发布
  resolveNextPost(env, 409, { error: "会话已封存，只读，不能再写入" });
  await settle(env);
  assert.equal(posts(env).length, 1);
  assert.ok(
    env.elements["anthology-error"].textContent.includes("已封存"),
    "应显示服务端拒绝原因"
  );
  assert.deepEqual(checkedNames(env), ["甲", "丙"], "拒绝后名单保留");
  await assertClosedUI(env, "发布拒绝不得重新启用发布或解除封存");

  // 迟到的旧轮询 closed=false 此刻才到：同样无效
  startPoll(env);
  resolveGet(env, { ok: true, json: async () => hostState({ closed: false }) });
  await settle(env);
  await assertClosedUI(env, "拒绝之后迟到的 closed=false 仍不得解除封存");

  // 另一条交错路径：在途发布等不到响应、直接网络失败——按钮仍不得启用
  // （新页面复现：发布在途 → 轮询显示封存 → 网络失败）
  const env2 = createPage();
  env2.curState = hostState();
  resolveGet(env2);
  await settle(env2);
  await setChecked(env2, "甲", true);
  await clickPublish(env2);
  await poll(env2, hostState({ closed: true }));
  await assertClosedUI(env2, "env2：等待期间封存");
  rejectNextPost(env2);
  await settle(env2);
  assert.equal(env2.elements["anthology-error"].textContent, "网络错误，请重试");
  await assertClosedUI(env2, "封存后的网络失败不得启用发布按钮");
});

test("封存按钮确认后立即只读：其后轮询网络失败或旧快照均不得撤销", async () => {
  const env = createPage();
  env.curState = hostState();
  resolveGet(env); // 首屏
  await settle(env);
  await setChecked(env, "甲", true);

  // 主持人点击永久封存：POST 在途
  await clickClose(env);
  assert.equal(env.pendingPosts.length, 1, "封存请求应在途");
  assert.equal(env.elements["anthology-publish"].disabled, false, "封存确认前合辑仍可操作");

  // 封存被服务端接受：页面立即锁存并切到封存只读（不必等下一次轮询）
  resolveNextPost(env, 200, { ok: true, closed: true });
  await settle(env);
  // 成功处理链发起的 refresh 仍挂起：即便它迟迟不返回，界面也已封存
  await assertClosedUI(env, "封存请求成功后应立即进入封存只读");
  assert.equal(env.pendingGets.length, 1, "成功后应发起一次刷新");

  // 这次刷新网络失败：封存提示与只读控件保持不变
  rejectGet(env);
  await settle(env);
  await assertClosedUI(env, "封存确认后的刷新网络失败不得撤销封存");

  // 任何迟到的 closed=false 旧快照也不能解除
  startPoll(env);
  resolveGet(env, { ok: true, json: async () => hostState({ closed: false }) });
  await settle(env);
  await assertClosedUI(env, "封存确认后迟到的 closed=false 不得解除封存");

  // 下一次正常的封存快照（带授权变化）仍被采纳
  const s = hostState({ closed: true });
  s.reviewers[2].anthology_consent = false;
  await poll(env, s);
  await assertClosedUI(env, "封存后正常轮询仍更新信息");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("ok - " + name);
    } catch (e) {
      failed++;
      console.error("FAIL - " + name);
      console.error(e);
    }
  }
  if (failed) {
    console.error(failed + " 个用例失败");
    process.exit(1);
  }
  console.log(tests.length + " 个用例全部通过");
})();
