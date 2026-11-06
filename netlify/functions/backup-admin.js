// netlify/functions/backup-admin.js — 临时管理小手机 Supabase 云端备份（列表 / 删除）
// 用法：?key=<ADMIN_KEY>&op=list|buckets|del&bucket=ai-phone-backup&paths=a|b

const ADMIN_KEY = "gjt-supa-7f3a9c";
const BUCKET_DEFAULT = "ai-phone-backup";
const SUPA = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://spywtqmpisctzsrnflen.supabase.co").replace(/\/$/, "");
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function json(o, s = 200) {
  return new Response(JSON.stringify(o), {
    status: s,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

async function api(path, init = {}) {
  const r = await fetch(SUPA + path, {
    ...init,
    headers: {
      apikey: SR,
      Authorization: `Bearer ${SR}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

export default async (req) => {
  const url = new URL(req.url);
  if ((url.searchParams.get("key") || "") !== ADMIN_KEY) return json({ error: "forbidden" }, 403);
  if (!SR) return json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" }, 500);

  const op = url.searchParams.get("op") || "list";
  const bucket = url.searchParams.get("bucket") || BUCKET_DEFAULT;

  if (op === "buckets") {
    const r = await api("/storage/v1/bucket");
    return json(r, r.status);
  }

  if (op === "list") {
    const items = [];
    const walk = async (prefix, depth) => {
      const r = await api(`/storage/v1/object/list/${bucket}`, {
        method: "POST",
        body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: "name", order: "asc" } }),
      });
      if (r.status !== 200 || !Array.isArray(r.body)) return r;
      for (const it of r.body) {
        const isFolder = it.id === null || it.id === undefined;
        const full = prefix ? `${prefix}/${it.name}` : it.name;
        if (isFolder) {
          if (depth < 6) await walk(full, depth + 1);
        } else {
          items.push({
            path: full,
            size: (it.metadata || {}).size || 0,
            updated: it.updated_at || (it.metadata || {}).lastModified || null,
            created: it.created_at || null,
          });
        }
      }
      return null;
    };
    const rr = await walk(url.searchParams.get("prefix") || "", 0);
    if (rr) return json(rr, rr.status);
    return json({ bucket, count: items.length, items });
  }

  if (op === "del") {
    const paths = (url.searchParams.get("paths") || "").split("|").map((s) => s.trim()).filter(Boolean);
    if (!paths.length) return json({ error: "no paths" }, 400);
    const r = await api(`/storage/v1/object/${bucket}`, { method: "DELETE", body: JSON.stringify({ prefixes: paths }) });
    return json({ requested: paths.length, result: r.body }, r.status);
  }

  return json({ error: "unknown op" }, 400);
};
