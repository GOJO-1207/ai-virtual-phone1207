// Netlify Function: 反向代理到 Cloudflare Worker 角色电脑
// 作用：绕过大陆对 *.workers.dev 的 DNS+SNI 阻断（小手机 -> netlify.app -> Worker）
// 完全透传方法/请求头/请求体，原样返回 Worker 的响应。
// 额外：对 /日记 的写入做「一天最多 6 篇」的软硬兜底（在服务端拦截，模型绕不过）。
const WORKER_URL = "https://ai-phone-agent-computer.hohohoho050320520.workers.dev";

// 逐跳头（hop-by-hop）与 Netlify 注入头不转发给 Worker
const SKIP_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "accept-encoding",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "x-forwarded-port",
  "x-netlify-original-path", "x-netlify-request-context", "x-deno-base-url", "cf-connecting-ip",
]);

// ── 日记节流配置 ───────────────────────────────────────────────
const DIARY_DIRS = ["/日记", "/diary", "/日記"];
const MAX_PER_DAY = 6;
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const DIARY_COUNT_CMD = 'find /日记 -maxdepth 1 -type f -printf "%T@\\n" 2>/dev/null';

function normPath(p) {
  let n = String(p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!n.startsWith("/")) n = "/" + n;
  return n;
}

function isDiaryPath(p) {
  const n = normPath(p);
  return DIARY_DIRS.some(d => n === d || n.startsWith(d + "/"));
}

function beijingDate(ts) {
  return new Date((ts || Date.now()) + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function beijingDayRange(ts) {
  const ymd = beijingDate(ts);
  const start = Date.parse(ymd + "T00:00:00+08:00");
  return { ymd, start, end: start + 24 * 3600 * 1000 };
}

function jsonOut(payload) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  };
}

async function workerCall(payload, headers) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data, text };
}

// 统计「今天（北京时间）」已经写了多少篇。
// 优先用文件 mtime（与文件名无关，最可靠）；取不到时退回按文件名里的日期统计。
async function countTodayDiary(workspace, headers) {
  const { ymd, start, end } = beijingDayRange();

  try {
    const r = await workerCall({ action: "exec", workspace, command: DIARY_COUNT_CMD }, headers);
    const out = r.data && typeof r.data.stdout === "string" ? r.data.stdout : null;
    const err = r.data && typeof r.data.stderr === "string" ? r.data.stderr : "";
    if (r.data && r.data.ok === true && out !== null) {
      const nums = out.split(/\s+/).filter(Boolean).map(Number).filter(n => Number.isFinite(n));
      if (nums.length) {
        const today = nums.filter(t => t >= start / 1000 && t < end / 1000).length;
        return { count: today, source: "mtime", date: ymd };
      }
      // 目录为空（无输出、无报错）→ 0 篇；有输出但解析不出数字 → 认为命令不可用，回退
      if (out.trim() === "" && err.trim() === "") return { count: 0, source: "mtime", date: ymd };
    }
  } catch { /* 落到下面的文件名统计 */ }

  try {
    const r = await workerCall({ action: "list", workspace, path: "/日记" }, headers);
    const entries = (r.data && (r.data.entries || r.data.items)) || [];
    const count = entries.filter(e => !e.dir && String(e.name || "").includes(ymd)).length;
    return { count, source: "name", date: ymd };
  } catch { /* 统计不到 */ }

  return { count: null, source: "unknown", date: ymd };
}

function isDiaryWriteCommand(cmd) {
  const c = String(cmd || "");
  if (!/日记|diary|日記/i.test(c)) return false;
  return />|>>|\btee\b|\bcp\b|\bmv\b|\btouch\b|\brm\b|sed\s+-i|\bdd\b|open\(/i.test(c);
}

function quotaMessage(date, count) {
  const c = count === null || count === undefined ? "" : `（${date} 已有 ${count} 篇）`;
  return `今天的日记已经写满 ${MAX_PER_DAY} 篇${c}。这一篇不写了，留到明天。`;
}

exports.handler = async (event) => {
  try {
    const headers = {};
    for (const [k, v] of Object.entries(event.headers || {})) {
      if (!SKIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    // 客户端只 POST 到 endpoint 根地址；保留原 path 以兼容未来扩展
    const path = (event.path || "").replace(/^\/\.netlify\/functions\/agent-proxy/, "") || "/";
    const body = event.body
      ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
      : undefined;

    // ── 日记写入节流 ───────────────────────────────────────────
    let req = null;
    try { req = body ? JSON.parse(body.toString("utf8")) : null; } catch { req = null; }
    if (req && typeof req === "object" && req.workspace && req.force !== true) {
      const action = String(req.action || "");
      const target = req.path || req.filePath || "";
      const isWrite = action === "write" || action === "write_base64" || action === "write_file";

      if (isWrite && isDiaryPath(target)) {
        const q = await countTodayDiary(req.workspace, headers);
        if (q.count !== null && q.count >= MAX_PER_DAY) {
          return jsonOut({ ok: false, error: quotaMessage(q.date, q.count), diaryFull: true, count: q.count, date: q.date });
        }
      } else if (action === "exec" && isDiaryWriteCommand(req.command)) {
        const q = await countTodayDiary(req.workspace, headers);
        if (q.count !== null && q.count >= MAX_PER_DAY) {
          return jsonOut({ ok: false, error: quotaMessage(q.date, q.count), diaryFull: true, count: q.count, date: q.date });
        }
      }
    }

    const res = await fetch(WORKER_URL + path, {
      method: event.httpMethod || "GET",
      headers,
      body,
    });

    const outHeaders = { "content-type": res.headers.get("content-type") || "application/json" };
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) outHeaders["set-cookie"] = setCookie;

    return {
      statusCode: res.status,
      headers: outHeaders,
      body: Buffer.from(await res.arrayBuffer()).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, error: "proxy_error: " + (err && err.message ? err.message : String(err)) }),
    };
  }
};
