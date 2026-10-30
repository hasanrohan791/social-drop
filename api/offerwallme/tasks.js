
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

// Create Offerwall.me signed user identity
function getSignedIdentity(userId) {
  const publicKey = process.env.OFFERWALLME_PUBLIC_API_KEY;
  const secret = process.env.OFFERWALLME_SECRET_KEY;

  if (!publicKey || !secret) {
    throw new Error("Offerwall.me credentials missing");
  }

  const expires = String(
    Math.floor(Date.now() / 1000) + 3600
  );

  const message =
    `offerwall-user-v1\n${publicKey}\n${userId}\n${expires}`;

  const signature = crypto
    .createHmac("sha256", secret)
    .update(message, "utf8")
    .digest("hex");

  return { expires, signature };
}

// Translate task content into Bangla
async function translateTasksToBangla(tasks) {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;

  if (!apiKey) {
    throw new Error("GOOGLE_TRANSLATE_API_KEY is missing");
  }

  if (!tasks.length) return [];

  const fields = [];

  for (const task of tasks) {
    fields.push(task.title || "");
    fields.push(task.description || "");
    fields.push(task.instructions || "");
  }

  const translations = [];

  // Translate in batches to avoid oversized requests
  for (let i = 0; i < fields.length; i += 50) {
    const batch = fields.slice(i, i + 50);

    const params = new URLSearchParams();
    params.append("target", "bn");
    params.append("format", "text");

    for (const value of batch) {
      params.append("q", value || " ");
    }

    const response = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) {
      throw new Error("Bangla translation request failed");
    }

    const result = await response.json();

    const batchTranslations =
      result?.data?.translations || [];

    if (batchTranslations.length !== batch.length) {
      throw new Error("Incomplete translation response");
    }

    translations.push(...batchTranslations);
  }

  return tasks.map((task, index) => ({
    ...task,

    // Original English content remains unchanged
    title: task.title,
    description: task.description,
    instructions: task.instructions,

    // Bangla translations
    titleBn:
      translations[index * 3]?.translatedText || "",

    descriptionBn:
      translations[index * 3 + 1]?.translatedText || "",

    instructionsBn:
      translations[index * 3 + 2]?.translatedText || "",
  }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    // 1. Verify Firebase user
    const authorization = req.headers.authorization || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        success: false,
        error: "Login required",
      });
    }

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const userId = decoded.uid;

    // 2. Check API credentials
    const publicKey = process.env.OFFERWALLME_PUBLIC_API_KEY;
    const bearerToken = process.env.OFFERWALLME_BEARER_TOKEN;

    if (!publicKey || !bearerToken ||
        !process.env.OFFERWALLME_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        error: "Offerwall configuration missing",
      });
    }

    // 3. Get user IP and country from Vercel headers
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
        success: false,
        error: "User IP or country unavailable",
      });
    }

    // 4. Generate signed identity
    const identity = getSignedIdentity(userId);

    // 5. Fetch live tasks from Offerwall.me
    const url = new URL(
      "https://offerwall.me/taskapi.php"
    );

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
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    const result = await response.json().catch(() => null);

    if (!response.ok || !result ||
        Number(result.status) !== 200) {
      return res.status(502).json({
        success: false,
        error: "Unable to fetch Offerwall.me tasks",
      });
    }

    const providerTasks = Array.isArray(result.data)
      ? result.data
      : [];

    // 6. Get this user's submitted tasks
    const submissionSnapshot = await db
      .collection("offerwallSubmissions")
      .where("userId", "==", userId)
      .get();

    const submittedTaskIds = new Set(
      submissionSnapshot.docs
        .filter(doc => {
          return doc.data().status !== "submission_failed";
        })
        .map(doc => String(doc.data().taskId))
    );

    // 7. Only show tasks currently returned by provider
    const tasks = providerTasks
      .filter(task => {
        const taskId = String(task.id || "");

        return taskId &&
          !submittedTaskIds.has(taskId);
      })
      .map(task => ({
        id: String(task.id),

        title: String(task.title || ""),
        description: String(task.description || ""),
        instructions: String(task.instructions || ""),

        proofType: String(task.proof_type || "Text"),
        proofText: String(task.proof_text || ""),

        reward: Number(task.reward || 0),

        countries: Array.isArray(task.countries)
          ? task.countries
          : [],

        approvalTime: Number(task.approval_time || 0),
        interval: Number(task.interval || 0),

        hasUrl: Boolean(task.has_url),
        url: String(task.url || ""),

        titleBn: "",
        descriptionBn: "",
        instructionsBn: "",
      }));

    // 8. Translate all task content
    const translatedTasks =
      await translateTasksToBangla(tasks);

    // 9. Return original English + Bangla
    return res.status(200).json({
      success: true,
      message: "Tasks loaded successfully",
      messageBn: "টাস্কের তালিকা পাওয়া গেছে",
      totalTasks: translatedTasks.length,
      tasks: translatedTasks,
    });

  } catch (error) {
    console.error(
      "Offerwall.me tasks error:",
      error.message
    );

    if (
      error.code === "auth/id-token-expired" ||
      error.code === "auth/invalid-id-token" ||
      error.code === "auth/argument-error"
    ) {
      return res.status(401).json({
        success: false,
        error: "Please login again",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Task loading failed",
    });
  }
}
