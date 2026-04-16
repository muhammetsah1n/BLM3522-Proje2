const express = require("express");
const axios = require("axios");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.YOUTUBE_API_KEY;
const AWS_REGION = process.env.AWS_REGION;
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

console.log("AWS_REGION:", AWS_REGION);
console.log("DYNAMODB_TABLE_NAME:", TABLE_NAME);
console.log("AWS_ACCESS_KEY_ID var mı:", !!process.env.AWS_ACCESS_KEY_ID);
console.log("AWS_SECRET_ACCESS_KEY var mı:", !!process.env.AWS_SECRET_ACCESS_KEY);
console.log("YOUTUBE_API_KEY var mı:", !!process.env.YOUTUBE_API_KEY);

const dynamoClient = new DynamoDBClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const docClient = DynamoDBDocumentClient.from(dynamoClient);

/*
  Demo mod için kanal bazlı sahte state tutuyoruz.
  Böylece aynı kanal demo modda her seferinde sıfırdan başlamaz.
*/
const demoState = {};

app.get("/", (req, res) => {
  res.send("YouTube Monitor Backend çalışıyor.");
});

function extractHandleFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;

    if (path.startsWith("/@")) {
      return path.substring(2);
    }

    return null;
  } catch (error) {
    return null;
  }
}

async function saveToDynamoDB(data) {
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          channelHandle: data.handle,
          fetchedAt: data.fetchedAt,
          title: data.title,
          profileImage: data.profileImage,
          subscribers: data.subscribers,
          views: data.views,
          videos: data.videos,
          mode: data.mode || "real",
        },
      })
    );

    console.log("Veri DynamoDB'ye kaydedildi.");
    return true;
  } catch (error) {
    console.error("DynamoDB kayıt hatası:", error);
    return false;
  }
}

async function getChannelHistory(handle) {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "channelHandle = :handle",
        ExpressionAttributeValues: {
          ":handle": handle,
        },
        ScanIndexForward: false,
        Limit: 50,
      })
    );

    return (result.Items || []).reverse();
  } catch (error) {
    console.error("DynamoDB geçmiş veri okuma hatası:", error);
    return [];
  }
}

async function fetchRealChannelData(handle) {
  const response = await axios.get(
    "https://www.googleapis.com/youtube/v3/channels",
    {
      params: {
        part: "snippet,statistics",
        forHandle: handle,
        key: API_KEY,
      },
    }
  );

  const items = response.data.items;

  if (!items || items.length === 0) {
    throw new Error("Kanal bulunamadı");
  }

  const channel = items[0];

  return {
    title: channel.snippet.title,
    profileImage: channel.snippet.thumbnails.default.url,
    subscribers: Number(channel.statistics.subscriberCount),
    views: Number(channel.statistics.viewCount),
    videos: Number(channel.statistics.videoCount),
    handle,
    fetchedAt: new Date().toISOString(),
    mode: "real",
  };
}

function generateDemoData(handle, baseData) {
  if (!demoState[handle]) {
    demoState[handle] = {
      subscribers: baseData.subscribers,
      views: baseData.views,
      videos: baseData.videos,
      title: baseData.title,
      profileImage: baseData.profileImage,
    };
  }

  const subscriberChangeOptions = [-1, 0, 1, 2];
  const viewsChangeOptions = [3, 5, 8, 12, 15, 20];

  const subscriberDelta =
    subscriberChangeOptions[
      Math.floor(Math.random() * subscriberChangeOptions.length)
    ];

  const viewsDelta =
    viewsChangeOptions[Math.floor(Math.random() * viewsChangeOptions.length)];

  demoState[handle].subscribers = Math.max(
    0,
    demoState[handle].subscribers + subscriberDelta
  );

  demoState[handle].views = Math.max(
    0,
    demoState[handle].views + viewsDelta
  );

  return {
    title: demoState[handle].title,
    profileImage: demoState[handle].profileImage,
    subscribers: demoState[handle].subscribers,
    views: demoState[handle].views,
    videos: demoState[handle].videos,
    handle,
    fetchedAt: new Date().toISOString(),
    mode: "demo",
  };
}

async function fetchChannelData(handle, mode = "real") {
  if (mode === "demo") {
    const realBase = await fetchRealChannelData(handle);
    const demoData = generateDemoData(handle, realBase);
    await saveToDynamoDB(demoData);
    return demoData;
  }

  const realData = await fetchRealChannelData(handle);
  await saveToDynamoDB(realData);
  return realData;
}

app.get("/channel", async (req, res) => {
  try {
    const channelUrl = req.query.url;
    const mode = req.query.mode || "real";

    if (!channelUrl) {
      return res.status(400).json({ error: "url gerekli" });
    }

    const handle = extractHandleFromUrl(channelUrl);

    if (!handle) {
      return res.status(400).json({
        error: "Geçerli bir YouTube kanal URL'si girilmedi",
      });
    }

    const data = await fetchChannelData(handle, mode);
    res.json(data);
  } catch (error) {
    console.error("HTTP hata:", error.response?.data || error.message);
    res.status(500).json({
      error: "Veri çekilirken hata oluştu",
      details: error.response?.data || error.message,
    });
  }
});

app.get("/channel-history", async (req, res) => {
  try {
    const channelUrl = req.query.url;

    if (!channelUrl) {
      return res.status(400).json({ error: "url gerekli" });
    }

    const handle = extractHandleFromUrl(channelUrl);

    if (!handle) {
      return res.status(400).json({
        error: "Geçerli bir YouTube kanal URL'si girilmedi",
      });
    }

    const history = await getChannelHistory(handle);

    res.json({
      handle,
      count: history.length,
      history,
    });
  } catch (error) {
    console.error("Geçmiş veri endpoint hatası:", error.message);
    res.status(500).json({
      error: "Geçmiş veriler alınamadı",
      details: error.message,
    });
  }
});

wss.on("connection", (ws) => {
  console.log("Bir istemci bağlandı.");

  let intervalId = null;

  ws.on("message", async (message) => {
    try {
      const parsedMessage = JSON.parse(message);
      const channelUrl = parsedMessage.url;
      const mode = parsedMessage.mode || "real";

      if (!channelUrl) {
        ws.send(JSON.stringify({ error: "url gerekli" }));
        return;
      }

      const handle = extractHandleFromUrl(channelUrl);

      if (!handle) {
        ws.send(JSON.stringify({ error: "Geçerli YouTube kanal URL'si değil" }));
        return;
      }

      if (intervalId) {
        clearInterval(intervalId);
      }

      const sendChannelData = async () => {
        try {
          const data = await fetchChannelData(handle, mode);
          ws.send(JSON.stringify(data));
        } catch (error) {
          console.error(
            "WebSocket veri çekme hatası:",
            error.response?.data || error.message
          );

          ws.send(
            JSON.stringify({
              error: "Veri çekme hatası",
              details: error.response?.data || error.message,
            })
          );
        }
      };

      await sendChannelData();
      intervalId = setInterval(sendChannelData, 5000);
    } catch (error) {
      console.error("Mesaj işleme hatası:", error.message);

      ws.send(
        JSON.stringify({
          error: "Mesaj işlenemedi",
          details: error.message,
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("İstemci bağlantısı kapandı.");
    if (intervalId) {
      clearInterval(intervalId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server ${PORT} portunda çalışıyor.`);
});