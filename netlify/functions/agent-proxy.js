// Netlify Function: 反向代理到 Cloudflare Worker 角色电脑
// 作用：绕过大陆对 *.workers.dev 的 DNS+SNI 阻断（小手机 -> netlify.app -> Worker）
// 完全透传方法/请求头/请求体，原样返回 Worker 的响应。
const WORKER_URL = "https://ai-phone-agent-computer.hohohoho050320520.workers.dev";

// 逐跳头（hop-by-hop）与 Netlify 注入头不转发给 Worker
const SKIP_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "accept-encoding",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "x-forwarded-port",
  "x-netlify-original-path", "x-netlify-request-context", "x-deno-base-url", "cf-connecting-ip",
]);

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
