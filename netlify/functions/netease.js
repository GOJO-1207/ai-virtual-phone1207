// Netlify Function：网易云音乐 API（兼容 NeteaseCloudMusicApi 常用接口）
// 对外：GET /song/detail?ids=xxx | /search?keywords=xxx | /song/url?id=xxx
// 数据源：网易云官方公开接口（本机/服务器均可用）
const NET = "https://music.163.com/api";

const HDR = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", Referer: "https://music.163.com/" };

function J(o) {
  return { statusCode: 200, headers: HDR, body: JSON.stringify(o) };
}

async function fj(url) {
  const r = await fetch(url, { headers: UA });
  return await r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HDR, body: "" };

  const q = event.queryStringParameters || {};
  const path = event.path || "";
  let action = q.action || "";
  if (!action) {
    if (path.indexOf("song/detail") !== -1) action = "song_detail";
    else if (path.indexOf("song/url") !== -1) action = "song_url";
    else if (path.indexOf("search") !== -1) action = "search";
  }

  try {
    if (action === "song_detail") {
      const ids = String(q.ids || "").replace(/[\[\]]/g, "");
      if (!ids) return J({ code: 400, msg: "缺少 ids 参数" });
      const j = await fj(`${NET}/song/detail/?id=${ids}&ids=[${ids}]`);
      // 兼容 NeteaseCloudMusicApi 格式：老接口返回 album/artists，转为 al.picUrl
      if (j && Array.isArray(j.songs)) {
        j.songs = j.songs.map(function (s) {
          if (s.al) return s;
          var al = s.album || {};
          var pic = (s.artists && s.artists[0] && s.artists[0].picUrl) || al.picUrl || "";
          var artist = (s.artists && s.artists[0] && s.artists[0].name) || "";
          return Object.assign({}, s, { al: { id: al.id || s.album ? (s.album.id) : 0, name: al.name || artist, picUrl: pic } });
        });
      }
      return J(j);
    }
    if (action === "search") {
      const kw = q.keywords || q.s || "";
      if (!kw) return J({ code: 400, msg: "缺少 keywords 参数" });
      const limit = q.limit || 20;
      const enc = encodeURIComponent(kw);
      const realIP = "116.25.146.177";
      const urls = [
        `${NET}/search/get/web?s=${enc}&type=1&limit=${limit}&realIP=${realIP}`,
        `${NET}/v1/search/get?s=${enc}&type=1&limit=${limit}&realIP=${realIP}`,
      ];
      for (const u of urls) {
        try {
          const j = await fj(u);
          if (j && typeof j.result === "object") return J(j);
        } catch (e) {}
      }
      return J({ code: 500, msg: "搜索服务暂不可用" });
    }
    if (action === "song_url") {
      const id = q.id || String(q.ids || "").replace(/[\[\]]/g, "");
      if (!id) return J({ code: 400, msg: "缺少 id 参数" });
      // 网易云播放地址需要登录态，公开接口拿不到完整 URL，返回空数组占位
      return J({ code: 200, data: [{ id: Number(id), url: null, br: 128000 }] });
    }
    return J({ code: 404, msg: "未知接口" });
  } catch (e) {
    return J({ code: 500, msg: "内部错误: " + e.message });
  }
};
