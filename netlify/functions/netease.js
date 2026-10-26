// Netlify Function：网易云音乐 API（兼容 NeteaseCloudMusicApi 常用接口）
// 对外：GET /song/detail?ids=xxx | /search?keywords=xxx | /song/url?id=xxx
//       GET /login/qr/key | /login/qr/create?key=xxx | /login/qr/check?key=xxx
// 数据源：网易云官方接口（song/search 走老接口；登录走 weapi 加密接口）
const crypto = require("crypto");

const NET = "https://music.163.com/api";

const HDR = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  Referer: "https://music.163.com/",
  "Content-Type": "application/x-www-form-urlencoded",
};

// ---- weapi 加密（NeteaseCloudMusicApi 同款）----
const MODULUS = "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
const PUBKEY = "010001";
const NONCE = "0CoJUm6Qyw8W8jud";
const IV = "0102030405060708";

function createSecretKey(size) {
  return crypto.randomBytes(size).toString("hex").slice(0, size);
}

function aesEncrypt(text, key, iv) {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

function rsaEncrypt(text) {
  const e = BigInt("0x" + PUBKEY);
  const m = BigInt("0x" + MODULUS);
  let msg = BigInt("0x" + Buffer.from(text, "utf8").toString("hex"));
  let result = 1n;
  let base = msg % m;
  let exp = e;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return result.toString(16).padStart(256, "0");
}

function weapiParams(obj) {
  const text = JSON.stringify(obj);
  const secretKey = createSecretKey(16);
  const params = aesEncrypt(aesEncrypt(text, NONCE, IV), secretKey, IV);
  const encSecKey = rsaEncrypt(secretKey.split("").reverse().join(""));
  return "params=" + encodeURIComponent(params) + "&encSecKey=" + encSecKey;
}

async function weapiPost(url, obj, cookie) {
  const h = Object.assign({}, UA);
  if (cookie) h.Cookie = cookie;
  h["X-Forwarded-For"] = "116.25.146.177";
  const r = await fetch(url, {
    method: "POST",
    headers: h,
    body: weapiParams(obj),
  });
  return await r.json();
}

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
    if (path.indexOf("login/qr/key") !== -1) action = "qr_key";
    else if (path.indexOf("login/qr/create") !== -1) action = "qr_create";
    else if (path.indexOf("login/qr/check") !== -1) action = "qr_check";
    else if (path.indexOf("song/detail") !== -1) action = "song_detail";
    else if (path.indexOf("song/url") !== -1) action = "song_url";
    else if (path.indexOf("search") !== -1) action = "search";
  }

  try {
    if (action === "qr_key") {
      const j = await weapiPost("https://music.163.com/weapi/login/qrcode/unikey", { type: 1 });
      // 兼容 NeteaseCloudMusicApi：unikey 包在 data 里
      if (j && j.unikey && !j.data) j.data = { unikey: j.unikey };
      return J(j);
    }
    if (action === "qr_create") {
      const key = q.key || "";
      if (!key) return J({ code: 400, msg: "缺少 key 参数" });
      const j = await weapiPost("https://music.163.com/weapi/login/qrcode/client/login", { key: key, type: 1, qrimg: true });
      if (j && j.qrimg && !j.data) j.data = { qrimg: j.qrimg };
      return J(j);
    }
    if (action === "qr_check") {
      const key = q.key || "";
      if (!key) return J({ code: 400, msg: "缺少 key 参数" });
      const j = await weapiPost("https://music.163.com/weapi/login/qrcode/client/login", { key: key, type: 1 });
      return J(j);
    }
    if (action === "song_detail") {
      const ids = String(q.ids || "").replace(/[\[\]]/g, "");
      if (!ids) return J({ code: 400, msg: "缺少 ids 参数" });
      const j = await fj(`${NET}/song/detail/?id=${ids}&ids=[${ids}]`);
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
      return J({ code: 200, data: [{ id: Number(id), url: null, br: 128000 }] });
    }
    return J({ code: 404, msg: "未知接口" });
  } catch (e) {
    return J({ code: 500, msg: "内部错误: " + e.message });
  }
};
