import admin from "firebase-admin";
import crypto from "crypto";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}

const db = admin.firestore();

function getSignedIdentity(userId) {
  const publicKey = process.env.OFFERWALLME_PUBLIC_API_KEY;
  const secret = process.env.OFFERWALLME_SECRET_KEY;

  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const message =
    `offerwall-user-v1\n${publicKey}\n${userId}\n${expires}`;

  const signature = crypto
    .createHmac("sha256", secret)
    .update(message, "utf8")
    .digest("hex");

  return { expires, signature };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const match = (req.headers.authorization || "")
      .match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({ error: "Login required" });
    }

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const userId = decoded.uid;

    const publicKey = process.env.OFFERWALLME_PUBLIC_API_KEY;
    const bearerToken = process.env.OFFERWALLME_BEARER_TOKEN;

    if (!publicKey || !bearerToken ||
        !process.env.OFFERWALLME_SECRET_KEY) {
      return res.status(500).json({
        error: "Offerwall configuration missing",
      });
    }

    const ipHeader = req.headers["x-vercel-forwarded-for"];
    const ip = typeof ipHeader === "string"
      ? ipHeader.split(",")[0].trim()
      : "";

    const countryHeader = req.headers["x-vercel-ip-country"];
    const country = typeof countryHeader === "string"
      ? countryHeader.trim().toUpperCase()
      : "";

    if (!ip || !/^[A-Z]{2}$/.test(country)) {
      return res.status(400).json({
        error: "IP or country unavailable",
      });
    }

    const identity = getSignedIdentity(userId);

    const url = new URL("https://offerwall.me/taskapi.php");

    url.search = new URLSearchParams({
      api: publicKey,
      token: bearerToken,
      id: userId,
      ip,
      country,
      identityExpires: identity.expires,
      identitySignature: identity.signature,
    }).toString();

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    const result = await response.json();

    if (!response.ok || Number(result.status) !== 200) {
      return res.status(502).json({
        error: "Unable to load tasks",
      });
    }

    const providerTasks = Array.isArray(result.data)
      ? result.data
      : [];

    // এই ইউজার ইতিমধ্যে যে Task Submit করেছে সেগুলো বাদ।
    const submissions = await db
      .collection("offerwallSubmissions")
      .where("userId", "==", userId)
      .get();

    const submittedIds = new Set(
      submissions.docs
        .filter(doc => doc.data().status !== "submission_failed")
        .map(doc => String(doc.data().taskId))
    );

    const tasks = providerTasks
      .filter(task => {
        const id = String(task.id || "");
        return id && !submittedIds.has(id);
      })
      .map(task => ({
        id: String(task.id),
        title: String(task.title || ""),
        description: String(task.description || ""),
        instructions: String(task.instructions || ""),
        proofType: String(task.proof_type || "Text"),
        proofText: String(task.proof_text || ""),
        reward: Number(task.reward || 0),
        countries: task.countries || [],
        approvalTime: Number(task.approval_time || 0),
        interval: Number(task.interval || 0),
        hasUrl: Boolean(task.has_url),
        url: task.url || "",
      }));

    return res.status(200).json({
      success: true,
      tasks,
    });

  } catch (error) {
    console.error("Tasks API:", error.message);

    return res.status(500).json({
      error: "Task loading failed",
    });
  }
}
