// Netlify Function: 反向代理到 Cloudflare Worker 网易云 VIP API
// 作用：绕过大陆对 *.workers.dev 的 DNS+SNI 阻断（小手机网易云插件 -> netlify.app -> Worker）
// 透传方法/路径/query/请求体，返回 Worker 的响应；补 CORS 头供小手机跨域调用。
const WORKER_URL = "https://netease-vip.hohohoho050320520.workers.dev";

const SKIP_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "accept-encoding",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "x-forwarded-port",
  "x-netlify-original-path", "x-netlify-request-context", "x-deno-base-url", "cf-connecting-ip",
]);

function corsHeaders(extra) {
  return Object.assign({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  }, extra || {});
}

exports.handler = async (event) => {
  // OPTIONS 预检直接放行
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  // 提取剩余 path：去掉函数自身前缀，保留 query
  let targetPath = "/";
  try {
    const url = new URL(event.rawUrl || event.url || "https://x/");
    const base = "/.netlify/functions/netease-proxy";
    let p = url.pathname;
    if (p.startsWith(base)) p = p.slice(base.length);
    targetPath = (p === "" || p === "/") ? "/" : p;
    const target = WORKER_URL + targetPath + url.search;

    const headers = {};
    for (const [k, v] of Object.entries(event.headers || {})) {
      if (SKIP_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = v;
    }

    let body;
    if (event.body && event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
      body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
    }

    const res = await fetch(target, {
      method: event.httpMethod || "GET",
      headers,
      body,
    });
    const text = await res.text();

    return {
      statusCode: res.status,
      headers: corsHeaders({
        "content-type": res.headers.get("content-type") || "application/json; charset=utf-8",
      }),
      body: text,
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: corsHeaders({ "content-type": "application/json; charset=utf-8" }),
      body: JSON.stringify({
        error: "netease_proxy_upstream_error",
        path: targetPath,
        message: String((e && e.message) || e),
      }),
    };
  }
};
