const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const axios = require("axios");
const { init: initDB, Counter } = require("./db");

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// 从环境变量中读取小程序与模板配置
// 请在云托管控制台「服务设置 -> 环境变量」中配置以下变量：
// WX_APPID               小程序 AppID
// WX_APPSECRET           小程序 AppSecret
// WX_SUBSCRIBE_TEMPLATE_ID 审核结果订阅消息/服务通知模板 ID
const {
  WX_APPID,
  WX_APPSECRET,
  WX_SUBSCRIBE_TEMPLATE_ID,
} = process.env;

// 获取 access_token（简单版本，未做缓存；生产可自行加缓存）
async function getAccessToken() {
  if (!WX_APPID || !WX_APPSECRET) {
    console.error("WX_APPID 或 WX_APPSECRET 未配置，无法发送服务通知");
    return null;
  }

  const resp = await axios.get(
    "https://api.weixin.qq.com/cgi-bin/token",
    {
      params: {
        grant_type: "client_credential",
        appid: WX_APPID,
        secret: WX_APPSECRET,
      },
    }
  );

  if (!resp.data || !resp.data.access_token) {
    console.error("获取 access_token 失败:", resp.data);
    return null;
  }

  return resp.data.access_token;
}

// 发送审核结果服务通知 / 订阅消息
// 注意：data 字段名需要与你在微信后台配置的模板字段匹配，请根据实际模板字段名修改
async function sendAuditResultNotify({
  openid,
  status,
  roomNumber,
  bookingId,
  rejectReason,
}) {
  if (!openid) {
    console.warn("openid 为空，跳过发送服务通知");
    return;
  }
  if (!WX_SUBSCRIBE_TEMPLATE_ID) {
    console.warn("WX_SUBSCRIBE_TEMPLATE_ID 未配置，跳过发送服务通知");
    return;
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return;
  }

  const isApproved = status === "confirmed" || status === "approved";
  const sendUrl = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`;

  // TODO：根据你在服务通知/订阅消息模板中的字段，调整 thingX / timeX 等字段名
  const payload = {
    touser: openid,
    template_id: WX_SUBSCRIBE_TEMPLATE_ID,
    page: "pages/index/index",
    data: {
      // 审核结果
      thing1: { value: isApproved ? "预约审核通过" : "预约审核未通过" },
      // 房间信息
      thing2: { value: roomNumber ? `房间 ${roomNumber}` : "预约房间" },
      // 预约编号 / 备注
      thing3: { value: bookingId || "预约记录" },
      // 说明 / 原因
      thing4: {
        value: isApproved
          ? "请按时前往琴房签到使用"
          : rejectReason || "审核未通过，请联系管理员了解详情",
      },
    },
  };

  const resp = await axios.post(sendUrl, payload);
  console.log("发送服务通知结果:", resp.data);
}

// 首页
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 更新计数 + 触发审核结果服务通知
app.post("/api/count", async (req, res) => {
  const {
    action,
    status,
    bookingId,
    roomNumber,
    userName,
    rejectReason,
  } = req.body;

  // 云托管会在带有用户身份的小程序调用中自动注入 x-wx-openid 头
  const openid = req.headers["x-wx-openid"];

  if (action === "inc") {
    await Counter.create();
  } else if (action === "clear") {
    await Counter.destroy({
      truncate: true,
    });
  }

  // 在计数逻辑之后，尝试发送审核结果服务通知（仅当 status 存在时）
  if (status) {
    try {
      await sendAuditResultNotify({
        openid,
        status,
        roomNumber,
        bookingId,
        rejectReason,
      });
    } catch (e) {
      console.error("发送服务通知失败:", e);
    }
  }

  res.send({
    code: 0,
    data: await Counter.count(),
  });
});

// 获取计数
app.get("/api/count", async (req, res) => {
  const result = await Counter.count();
  res.send({
    code: 0,
    data: result,
  });
});

// 小程序调用，获取微信 Open ID
app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("启动成功", port);
  });
}

bootstrap();
