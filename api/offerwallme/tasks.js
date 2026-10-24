
import admin from "firebase-admin";
import crypto from "crypto";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}

function getSignedIdentity(userId) {
  const publicKey = process.env.OFFERWALLME_PUBLIC_API_KEY;
  const secret = process.env.OFFERWALLME_SECRET_KEY;

  if (!publicKey || !secret) {
    throw new Error("Offerwall.me identity configuration missing");
  }

  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const message = `offerwall-user-v1\n${publicKey}\n${userId}\n${expires}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(message, "utf8")
    .digest("hex");

  return { publicKey, expires, signature };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "শুধু GET অনুরোধ গ্রহণযোগ্য",
    });
  }

  try {
    const authorization = req.headers.authorization || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        error: "প্রথমে লগইন করুন",
      });
    }

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const userId = decoded.uid;

    const publicKey = process.env.OFFERWALLME_PUBLIC_API_KEY;
    const bearerToken = process.env.OFFERWALLME_BEARER_TOKEN;

    if (!publicKey || !bearerToken) {
      console.error("Offerwall.me API configuration missing");
      return res.status(500).json({
        error: "সার্ভারের সেটআপ অসম্পূর্ণ",
      });
    }

    // Only use the IP and country headers supplied by Vercel's
    // trusted request infrastructure. Do not accept them from query/body.
    const ipHeader = req.headers["x-vercel-forwarded-for"];
    const ip = typeof ipHeader === "string"
      ? ipHeader.split(",")[0].trim()
      : "";

    const countryHeader = req.headers["x-vercel-ip-country"];
    const country = typeof countryHeader === "string"
      ? countryHeader.trim().toUpperCase()
      : "";

    if (!ip || !country || !/^[A-Z]{2}$/.test(country)) {
      return res.status(400).json({
        error: "নিরাপদভাবে IP বা দেশের তথ্য যাচাই করা যায়নি",
      });
    }

    const identity = getSignedIdentity(userId);

    const url = new URL("https://offerwall.me/taskapi.php");
    url.search = new URLSearchParams({
      api: publicKey,
      id: userId,
      ip,
      token: bearerToken,
      country,
      identityExpires: identity.expires,
      identitySignature: identity.signature,
    }).toString();

    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    const result = await response.json().catch(() => null);

    if (!response.ok || !result || Number(result.status) !== 200) {
      console.error("Offerwall.me task API failed", response.status);
      return res.status(502).json({
        error: "এই মুহূর্তে টাস্ক আনা যাচ্ছে না",
      });
    }

    const tasks = Array.isArray(result.data) ? result.data : [];

    // Keep advertiser instructions intact; show the surrounding
    // app labels in Bengali. Translate task content separately.
    return res.status(200).json({
      success: true,
      messageBn: "টাস্কের তালিকা পাওয়া গেছে",
      tasks: tasks.map((task) => ({
        id: String(task.id || ""),
        title: String(task.title || "নাম দেওয়া হয়নি"),
        description: String(task.description || ""),
        instructions: String(task.instructions || ""),
        proofType: String(task.proof_type || "Text"),
        proofText: String(task.proof_text || ""),
        reward: Number(task.reward || 0),
        countries: Array.isArray(task.countries) ? task.countries : [],
        approvalTime: Number(task.approval_time || 0),
        interval: Number(task.interval || 0),
      })),
    });
  } catch (error) {
    console.error("Offerwall.me tasks error:", error.message);

    if (error.code === "auth/id-token-expired" ||
        error.code === "auth/argument-error" ||
        error.code === "auth/invalid-id-token") {
      return res.status(401).json({
        error: "আপনার লগইন মেয়াদ শেষ। আবার লগইন করুন",
      });
    }

    return res.status(500).json({
      error: "টাস্ক লোড করতে সমস্যা হয়েছে",
    });
  }
}
