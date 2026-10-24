
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

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "শুধু POST অনুরোধ গ্রহণযোগ্য",
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

    const body = req.body || {};
    const taskId = String(body.taskId || "").trim();
    const proof = String(body.proof || "").trim();

    if (!taskId || taskId.length > 200) {
      return res.status(400).json({
        error: "সঠিক টাস্ক নির্বাচন করুন",
      });
    }

    if (!proof || proof.length > 5000) {
      return res.status(400).json({
        error: "প্রমাণ লিখুন (সর্বোচ্চ ৫০০০ অক্ষর)",
      });
    }

    // Use only trusted infrastructure headers for IP/country.
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

    const response = await fetch(
      "https://offerwall.me/tasksubmit.php",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api: publicKey,
          token: bearerToken,
          id: userId,
          identityExpires: identity.expires,
          identitySignature: identity.signature,
          country,
          task_id: taskId,
          ip,
          proof,
        }),
        signal: AbortSignal.timeout(20000),
      }
    );

    const result = await response.json().catch(() => null);

    if (!response.ok || !result) {
      console.error("Offerwall.me submission failed", response.status);
      return res.status(502).json({
        error: "প্রমাণ জমা দেওয়া যায়নি। পরে আবার চেষ্টা করুন",
      });
    }

    // Do not credit a wallet here. Only the verified postback
    // is allowed to trigger a reward after checking its status.
    const statusText = String(
      result.status || result.message || ""
    ).toLowerCase();

    let statusBn = "জমা হয়েছে; অনুমোদনের অপেক্ষায়";
    if (statusText.includes("approved")) {
      statusBn = "জমা হয়েছে; রিওয়ার্ডের postback-এর অপেক্ষায়";
    } else if (statusText.includes("pending")) {
      statusBn = "জমা হয়েছে; যাচাই চলছে";
    } else if (statusText.includes("reject") ||
               statusText.includes("fail") ||
               statusText.includes("error")) {
      statusBn = "জমা গ্রহণ হয়নি; নিচের বার্তাটি পরীক্ষা করুন";
    }

    return res.status(200).json({
      success: true,
      messageBn: statusBn,
      providerResponse: result,
      walletCredited: false,
    });
  } catch (error) {
    console.error("Offerwall.me submit error:", error.message);

    if (error.code === "auth/id-token-expired" ||
        error.code === "auth/argument-error" ||
        error.code === "auth/invalid-id-token") {
      return res.status(401).json({
        error: "আপনার লগইন মেয়াদ শেষ। আবার লগইন করুন",
      });
    }

    return res.status(500).json({
      error: "প্রমাণ জমা দেওয়ার সময় সমস্যা হয়েছে",
    });
  }
}
