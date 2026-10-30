
import admin from "firebase-admin";
import crypto from "crypto";

// ==========================================
// 1. FIREBASE INITIALIZATION
// ==========================================

if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!serviceAccount) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is missing");
  }

  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(serviceAccount)
    ),
  });
}

const db = admin.firestore();

// ==========================================
// 2. SIGNED USER IDENTITY
// ==========================================

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

// ==========================================
// 3. BANGLA TRANSLATION
// ==========================================

async function translateTasksToBangla(tasks) {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;

  // Translation key না থাকলে Original English দেখাবে।
  if (!apiKey || tasks.length === 0) {
    console.warn("Translation key missing; using English");

    return tasks.map(task => ({
      ...task,
      titleBn: "",
      descriptionBn: "",
      instructionsBn: "",
    }));
  }

  // প্রতিটি Task-এর তিনটি লেখা অনুবাদ হবে।
  const fields = [];

  for (const task of tasks) {
    fields.push(task.title || "");
    fields.push(task.description || "");
    fields.push(task.instructions || "");
  }

  const translated = [];

  try {
    // একবারে সর্বোচ্চ 30টি লেখা পাঠানো হবে।
    for (let i = 0; i < fields.length; i += 30) {
      const batch = fields.slice(i, i + 30);

      const params = new URLSearchParams();

      params.append("target", "bn");
      params.append("format", "text");

      for (const value of batch) {
        params.append("q", value || " ");
      }

      const response = await fetch(
        "https://translation.googleapis.com/language/translate/v2",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString() +
            "&key=" + encodeURIComponent(apiKey),
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!response.ok) {
        throw new Error(
          `Google Translation HTTP ${response.status}`
        );
      }

      const result = await response.json();

      const items = result?.data?.translations;

      if (!Array.isArray(items) || items.length !== batch.length) {
        throw new Error("Invalid translation response");
      }

      translated.push(
        ...items.map(item => item.translatedText || "")
      );
    }

    // English এবং Bangla একসঙ্গে ফেরত পাঠানো।
    return tasks.map((task, index) => ({
      ...task,

      titleBn: translated[index * 3] || "",
      descriptionBn: translated[index * 3 + 1] || "",
      instructionsBn: translated[index * 3 + 2] || "",
    }));

  } catch (error) {
    // Translation ব্যর্থ হলেও Task Loading বন্ধ হবে না।
    console.error("Bangla translation failed:", error.message);

    return tasks.map(task => ({
      ...task,
      titleBn: "",
      descriptionBn: "",
      instructionsBn: "",
    }));
  }
}

// ==========================================
// 4. GET USER IP AND COUNTRY
// ==========================================

function getUserNetworkInfo(req) {
  const forwardedFor =
    req.headers["x-vercel-forwarded-for"] ||
    req.headers["x-forwarded-for"];

  const ip = typeof forwardedFor === "string"
    ? forwardedFor.split(",")[0].trim()
    : "";

  const countryHeader =
    req.headers["x-vercel-ip-country"];

  const country = typeof countryHeader === "string"
    ? countryHeader.trim().toUpperCase()
    : "";

  return { ip, country };
}

// ==========================================
// 5. MAIN TASK API
// ==========================================

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  let stage = "initialization";

  try {
    // Firebase authentication
    stage = "authentication";

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

    // Environment variables
    stage = "configuration";

    const publicKey = process.env.OFFERWALLME_PUBLIC_API_KEY;
    const bearerToken = process.env.OFFERWALLME_BEARER_TOKEN;

    if (
      !publicKey ||
      !bearerToken ||
      !process.env.OFFERWALLME_SECRET_KEY
    ) {
      throw new Error("Offerwall.me environment variables missing");
    }

    // User IP and country
    stage = "network";

    const { ip, country } = getUserNetworkInfo(req);

    if (!ip || !/^[A-Z]{2}$/.test(country)) {
      throw new Error("User IP or country unavailable");
    }

    // Signed identity
    stage = "identity";

    const identity = getSignedIdentity(userId);

    // Offerwall.me API request
    stage = "provider_api";

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

    const providerResponse = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    const providerResult = await providerResponse.json();

    if (!providerResponse.ok) {
      throw new Error(
        `Offerwall.me HTTP ${providerResponse.status}`
      );
    }

    if (Number(providerResult?.status) !== 200) {
      console.error(
        "Offerwall.me response:",
        JSON.stringify(providerResult).slice(0, 1000)
      );

      throw new Error("Offerwall.me rejected the request");
    }

    const providerTasks = Array.isArray(providerResult.data)
      ? providerResult.data
      : [];

    // ======================================
    // 6. REMOVE TASKS ALREADY SUBMITTED
    // ======================================

    stage = "submission_history";

    const submissionSnapshot = await db
      .collection("offerwallSubmissions")
      .where("userId", "==", userId)
      .get();

    const submittedTaskIds = new Set();

    for (const document of submissionSnapshot.docs) {
      const submission = document.data();

      if (
        submission.status !== "submission_failed" &&
        submission.taskId
      ) {
        submittedTaskIds.add(
          String(submission.taskId)
        );
      }
    }

    // ======================================
    // 7. FORMAT LIVE PROVIDER TASKS
    // ======================================

    stage = "task_formatting";

    const tasks = providerTasks
      .filter(task => {
        const id = String(task?.id || "");

        return id && !submittedTaskIds.has(id);
      })
      .map(task => ({
        id: String(task.id),

        // Original English
        title: String(task.title || ""),
        description: String(task.description || ""),
        instructions: String(task.instructions || ""),

        // Bangla translation placeholders
        titleBn: "",
        descriptionBn: "",
        instructionsBn: "",

        // Proof
        proofType: String(task.proof_type || "Text"),
        proofText: String(task.proof_text || ""),

        // Reward
        reward: Number(task.reward || 0),

        // Task details
        countries: Array.isArray(task.countries)
          ? task.countries
          : [],

        approvalTime: Number(task.approval_time || 0),
        interval: Number(task.interval || 0),

        // URL
        hasUrl: Boolean(task.has_url),
        url: String(task.url || ""),
      }));

    // ======================================
    // 8. TRANSLATE TASKS
    // ======================================

    stage = "translation";

    const finalTasks = await translateTasksToBangla(tasks);

    // ======================================
    // 9. SEND RESPONSE
    // ======================================

    return res.status(200).json({
      success: true,
      message: "Tasks loaded successfully",
      messageBn: "টাস্ক সফলভাবে লোড হয়েছে",

      totalTasks: finalTasks.length,

      languageAvailable: ["en", "bn"],

      tasks: finalTasks,
    });

  } catch (error) {
    console.error("TASK API ERROR:", {
      stage,
      message: error.message,
    });

    if (
      error.code === "auth/id-token-expired" ||
      error.code === "auth/invalid-id-token" ||
      error.code === "auth/argument-error"
    ) {
      return res.status(401).json({
        success: false,
        error: "Login expired. Please login again.",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Task loading failed",
      stage,
    });
  }
}
