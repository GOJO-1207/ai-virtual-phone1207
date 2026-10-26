// 小红书读取后端（Netlify Function 版）
// 对外接口：POST /api/xhs-card | /api/xhs-images | /api/xhs-search

const API_KEY = (process.env.TIKHUB_API_KEY || "").trim();

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const CH = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function J(d, s) {
  return {
    statusCode: s || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CH),
    body: JSON.stringify(d),
  };
}

function bodyOf(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch (e) {
    return {};
  }
}

function extractTitle(title, desc) {
  if (title) return title;
  if (!desc) return "";
  var clean = desc.replace(/\[话题\]/g, "").trim();
  if (clean.length > 30) clean = clean.slice(0, 30) + "...";
  return clean;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers: CH, body: "" };

  var q = event.queryStringParameters || {};
  var p = event.path || "";
  var action = q.action || "";

  if (action === "card" || p.indexOf("xhs-card") !== -1) return handleCard(event);
  if (action === "images" || p.indexOf("xhs-images") !== -1) return handleImages(event);
  if (action === "search" || p.indexOf("xhs-search") !== -1) return handleSearch(event);
  return J({ ok: false, error: "未知接口", path: p }, 404);
};

async function handleCard(event) {
  try {
    var b = bodyOf(event);
    var noteId = b.noteId || "";
    var shareText = b.shareText || "";
    var shareUrl = "";
    var commentCount = b.commentCount || 10;
    var commentSort = b.commentSort || "latest_v2";
    var fetchCommentFlag = b.fetchComments !== false;

    if (!noteId && shareText) {
      var m1 = shareText.match(/https?:\/\/xhslink\.cn\/[a-zA-Z0-9/]+/);
      if (m1) shareUrl = m1[0];
      var m2 = shareText.match(
        /xiaohongshu\.com\/(explore|discovery\/item)\/([a-zA-Z0-9]+)/
      );
      if (m2) noteId = m2[2];
    }
    if (!shareUrl && !noteId) return J({ ok: false, error: "缺少参数" });

    var note = null;
    // 优先 TikHub（直连小红书已被风控拦截，先试只会白等数秒）
    if (API_KEY) {
      try {
        note = await fetchTikHubImage(noteId, shareUrl || shareText);
      } catch (e) {}
    }
    if (!note) {
      try {
        note = await fetchDirect(noteId, shareUrl);
      } catch (e) {}
    }
    if (!note)
      return J({
        ok: false,
        error: API_KEY ? "无法获取笔记" : "未配置 TIKHUB_API_KEY，且直连抓取已失效",
      });

    var rid = note.noteId || noteId;
    if (rid && fetchCommentFlag && API_KEY) {
      try {
        var cmts = await fetchComments(rid, commentCount, commentSort);
        if (cmts && cmts.length > 0) note.comments = cmts;
      } catch (e) {}
    }
    if (note.type === "video" && !note.videoUrl && rid && API_KEY) {
      try {
        note.videoUrl = await fetchTikHubVideo(rid);
      } catch (e) {}
    }
    return J({ ok: true, note: note, source: note._source || "unknown" });
  } catch (e) {
    return J({ ok: false, error: e.message });
  }
}

async function handleImages(event) {
  try {
    var b = bodyOf(event);
    if (!b.urls) return J({ ok: false, error: "缺少urls" });
    var rs = await Promise.all(
      b.urls.slice(0, 10).map(async function (u) {
        try {
          var rp = await fetch(u, {
            headers: {
              "User-Agent": UA,
              Referer: "https://www.xiaohongshu.com/",
            },
          });
          if (!rp.ok) return null;
          var buf = await rp.arrayBuffer();
          var bytes = new Uint8Array(buf);
          var bin = "";
          for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          return {
            url: u,
            base64: Buffer.from(bytes).toString("base64"),
            mime: rp.headers.get("content-type") || "image/webp",
          };
        } catch (e) {
          return null;
        }
      })
    );
    return J({ ok: true, images: rs.filter(Boolean) });
  } catch (e) {
    return J({ ok: false, error: e.message });
  }
}

async function handleSearch(event) {
  try {
    var b = bodyOf(event);
    var keyword = b.keyword || "";
    var count = b.count || 5;
    if (!keyword) return J({ ok: false, error: "缺少keyword" });
    if (!API_KEY) return J({ ok: false, error: "搜索功能需要TikHub API Key" });

    var items = await doSearch(keyword);
    if ((!items || items.length === 0) && keyword.length > 4) {
      items = await doSearch(keyword.substring(0, Math.ceil(keyword.length / 2)));
    }
    if ((!items || items.length === 0) && keyword.length > 2) {
      items = await doSearch(keyword.substring(0, 2));
    }
    if (!items || items.length === 0) return J({ ok: false, error: "没有找到相关内容" });

    var results = items
      .slice(0, count)
      .map(function (item) {
        var note = item.note || {};
        var imgs = (note.images_list || [])
          .map(function (i) {
            return i.url || i.original || "";
          })
          .filter(Boolean);
        return {
          noteId: note.id || "",
          title: extractTitle(note.title, note.desc),
          author:
            (note.user &&
              (note.user.nickname || note.user.nickName || note.user.name)) ||
            "",
          desc: (note.desc || "").replace(/\[话题\]/g, "").trim(),
          cover: imgs[0] || "",
          imageCount: imgs.length,
          likedCount: note.liked_count || 0,
          commentCount: note.comments_count || 0,
          collectedCount: note.collected_count || 0,
          type: note.type || "normal",
          url: "https://www.xiaohongshu.com/explore/" + (note.id || ""),
        };
      })
      .filter(function (r) {
        return r.noteId;
      });
    return J({ ok: true, results: results, total: items.length });
  } catch (e) {
    return J({ ok: false, error: e.message });
  }
}

async function doSearch(keyword) {
  try {
    var u =
      "https://api.tikhub.dev/api/v1/xiaohongshu/app_v2/search_notes?keyword=" +
      encodeURIComponent(keyword) +
      "&page=1&sort_type=general";
    var rp = await fetch(u, { headers: { Authorization: "Bearer " + API_KEY } });
    var d = await rp.json();
    if (d.code !== 200 || !d.data || !d.data.data) return null;
    return d.data.data.items || [];
  } catch (e) {
    return null;
  }
}

async function fetchDirect(noteId, shareUrl) {
  if (!noteId && shareUrl) {
    var r = await fetch(shareUrl, {
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    var m = r.url.match(/xiaohongshu\.com\/(explore|discovery\/item)\/([a-zA-Z0-9]+)/);
    if (m) noteId = m[2];
    if (!noteId) return null;
    return parsePage(await r.text(), noteId, r.url);
  }
  if (noteId) {
    var r2 = await fetch("https://www.xiaohongshu.com/explore/" + noteId, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      redirect: "follow",
    });
    return parsePage(await r2.text(), noteId, r2.url);
  }
  return null;
}

function parsePage(html, noteId, finalUrl) {
  var m = html.match(/window\.__INITIAL_STATE__\s*=\s*(.+?)<\/script>/s);
  if (!m) return null;
  var state;
  try {
    state = new Function("return " + m[1].trim().replace(/;$/, ""))();
  } catch (e) {
    try {
      state = JSON.parse(
        m[1].replace(/\\u002F/g, "/").replace(/:\s*undefined/g, ":null").trim().replace(/;$/, "")
      );
    } catch (e2) {
      return null;
    }
  }
  var nd = null;
  if (state.noteData) {
    nd =
      (state.noteData.data && state.noteData.data.noteData) ||
      (state.noteData.normalNotePreloadData && state.noteData.normalNotePreloadData.noteData) ||
      null;
    if (!nd && state.noteData.data && typeof state.noteData.data === "object") {
      for (var k of Object.keys(state.noteData.data)) {
        if (state.noteData.data[k] && state.noteData.data[k].title) {
          nd = state.noteData.data[k];
          break;
        }
      }
    }
  }
  if (!nd && state.note && state.note.noteDetailMap) {
    var ks = Object.keys(state.note.noteDetailMap);
    if (ks[0]) nd = state.note.noteDetailMap[ks[0]].note;
  }
  if (!nd || (!nd.title && !nd.desc)) return null;

  var author = "";
  if (nd.user) author = nd.user.nickName || nd.user.nickname || nd.user.name || nd.user.nick_name || "";
  if (!author && nd.noteUser) author = nd.noteUser.nickName || nd.noteUser.nickname || nd.noteUser.name || "";
  if (!author && state.user) author = state.user.nickName || state.user.nickname || state.user.name || "";
  if (!author) {
    var am =
      html.match(/name="author"[^>]+content="([^"]*)"/) ||
      html.match(/content="([^"]*)"[^>]+name="author"/);
    if (am) author = am[1];
  }

  var rawDesc = nd.desc || "";
  var title = extractTitle(nd.title, rawDesc);
  var imgs = (nd.imageList || [])
    .map(function (i) {
      if (i.infoList && i.infoList.length > 0) {
        var best =
          i.infoList.find(function (x) {
            return x.imageScene === "WB_DFT";
          }) || i.infoList[i.infoList.length - 1];
        if (best && best.url) {
          var u = best.url;
          if (u.startsWith("//")) u = "https:" + u;
          return u;
        }
      }
      var u2 = i.urlDefault || i.url || "";
      if (u2.startsWith("//")) u2 = "https:" + u2;
      return u2;
    })
    .filter(Boolean);

  var videoUrl = null;
  if (nd.video) {
    try {
      videoUrl =
        (nd.video.media &&
          nd.video.media.stream &&
          nd.video.media.stream.h264 &&
          nd.video.media.stream.h264[0] &&
          (nd.video.media.stream.h264[0].masterUrl ||
            nd.video.media.stream.h264[0].master_url)) ||
        null;
      if (!videoUrl && nd.video.consumer && nd.video.consumer.originVideoKey)
        videoUrl = "https://sns-video-bd.xhscdn.com/" + nd.video.consumer.originVideoKey;
      if (!videoUrl) videoUrl = nd.video.url || null;
    } catch (e) {}
  }

  var cmts = [];
  var cd = (state.commentData && state.commentData.comments) || [];
  if (Array.isArray(cd))
    cd.slice(0, 10).forEach(function (c) {
      cmts.push({
        user: (c.userInfo && (c.userInfo.nickName || c.userInfo.nickname)) || "匿名",
        content: c.content || "",
        ipLocation: c.ipLocation || "",
        likeCount: c.likeCount || 0,
      });
    });

  return {
    _source: "direct",
    noteId: noteId,
    title: title,
    author: author,
    desc: rawDesc.replace(/\[话题\]/g, "").trim(),
    images: imgs,
    imageCount: imgs.length,
    likedCount: (nd.interactInfo && nd.interactInfo.likedCount) || 0,
    commentCount: (nd.interactInfo && nd.interactInfo.commentCount) || 0,
    collectedCount: (nd.interactInfo && nd.interactInfo.collectedCount) || 0,
    comments: cmts,
    type: nd.type || (videoUrl ? "video" : "normal"),
    videoUrl: videoUrl,
    url: finalUrl || "https://www.xiaohongshu.com/explore/" + noteId,
  };
}

async function fetchTikHubImage(noteId, shareText) {
  var u = "https://api.tikhub.dev/api/v1/xiaohongshu/app_v2/get_image_note_detail?";
  if (noteId) u += "note_id=" + encodeURIComponent(noteId);
  else {
    var m = String(shareText || "").match(/https?:\/\/xhslink\.cn\/[a-zA-Z0-9/]+/);
    u += "share_text=" + encodeURIComponent(m ? m[0] : shareText);
  }
  var r = await fetch(u, { headers: { Authorization: "Bearer " + API_KEY } });
  var d = await r.json();
  if (d.code !== 200 || !d.data || !d.data.success)
    throw new Error(d.message || "API失败");

  var n = d.data.data[0].note_list[0];
  var rawDesc = n.desc || "";
  var title = extractTitle(n.title, rawDesc);
  var imgs = (n.images_list || []).map(function (i) {
    return i.url || i.original || "";
  }).filter(Boolean);
  var tags = (n.hash_tag || []).map(function (t) {
    return t.name;
  }).filter(Boolean);

  return {
    _source: "tikhub",
    noteId: n.id || noteId || "",
    title: title,
    author: (n.user && (n.user.nickname || n.user.nickName)) || "",
    desc: rawDesc.replace(/\[话题\]/g, "").trim(),
    images: imgs,
    imageCount: imgs.length,
    likedCount: n.liked_count || 0,
    commentCount: n.comments_count || 0,
    collectedCount: n.collected_count || 0,
    comments: [],
    tags: tags,
    type: n.type || "normal",
    videoUrl: null,
    url: (n.share_info && n.share_info.link) || "",
  };
}

var PM = {
  Beijing: "北京", Tianjin: "天津", Shanghai: "上海", Chongqing: "重庆", Hebei: "河北",
  Shanxi: "山西", Liaoning: "辽宁", Jilin: "吉林", Heilongjiang: "黑龙江", Jiangsu: "江苏",
  Zhejiang: "浙江", Anhui: "安徽", Fujian: "福建", Jiangxi: "江西", Shandong: "山东",
  Henan: "河南", Hubei: "湖北", Hunan: "湖南", Guangdong: "广东", Hainan: "海南",
  Sichuan: "四川", Guizhou: "贵州", Yunnan: "云南", Shaanxi: "陕西", Gansu: "甘肃",
  Qinghai: "青海", Taiwan: "台湾", "Inner Mongolia": "内蒙古", Guangxi: "广西",
  Tibet: "西藏", Ningxia: "宁夏", Xinjiang: "新疆", "Hong Kong": "香港", Macao: "澳门",
};

async function fetchComments(noteId, count, sort) {
  var u =
    "https://api.tikhub.dev/api/v1/xiaohongshu/app_v2/get_note_comments?note_id=" +
    encodeURIComponent(noteId) +
    "&index=0&sort_strategy=" +
    encodeURIComponent(sort);
  var r = await fetch(u, { headers: { Authorization: "Bearer " + API_KEY } });
  var d = await r.json();
  if (d.code !== 200 || !d.data || !d.data.data) return [];
  var cmts = d.data.data.comments || [];
  return cmts.slice(0, count).map(function (c) {
    var loc = c.ip_location || "";
    if (loc && PM[loc]) loc = PM[loc];
    return {
      user:
        (c.user && c.user.nickname) ||
        (c.user_info && (c.user_info.nickname || c.user_info.nickName)) ||
        "匿名",
      content: c.content || "",
      ipLocation: loc,
      likeCount: c.like_count || 0,
    };
  });
}

async function fetchTikHubVideo(noteId) {
  var u =
    "https://api.tikhub.dev/api/v1/xiaohongshu/app_v2/get_video_note_detail?note_id=" +
    encodeURIComponent(noteId);
  var r = await fetch(u, { headers: { Authorization: "Bearer " + API_KEY } });
  var d = await r.json();
  if (d.code !== 200 || !d.data || !d.data.success)
    throw new Error(d.message || "视频API失败");
  var s = JSON.stringify(d.data);
  var i = s.indexOf("master_url");
  if (i === -1) return null;
  var m = s.substring(i).match(/master_url":"([^"]+)"/);
  return m ? m[1] : null;
}