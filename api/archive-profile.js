// api/archive-profile.js

import admin from "firebase-admin";
import crypto from "crypto";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
  });
}

const db = admin.firestore();

function getToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.substring(7).trim();
}

function getPublicIdFromCloudinaryUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }

  try {
    const parsed = new URL(url);

    if (!parsed.hostname.includes("res.cloudinary.com")) {
      return null;
    }

    const marker = "/image/upload/";
    const index = parsed.pathname.indexOf(marker);

    if (index === -1) {
      return null;
    }

    let path = parsed.pathname.substring(index + marker.length);

    // Version অংশ বাদ
    path = path.replace(/^v\d+\//, "");

    // Transformation থাকলে বাদ
    const parts = path.split("/");

    while (
      parts.length > 1 &&
      (
        parts[0].includes(",") ||
        parts[0].startsWith("c_") ||
        parts[0].startsWith("f_") ||
        parts[0].startsWith("q_") ||
        parts[0].startsWith("w_") ||
        parts[0].startsWith("h_") ||
        parts[0].startsWith("g_") ||
        parts[0].startsWith("e_")
      )
    ) {
      parts.shift();
    }

    path = parts.join("/");

    // Extension বাদ
    path = path.replace(/\.[^/.]+$/, "");

    return path || null;

  } catch {
    return null;
  }
}

function createSignature(params) {
  const stringToSign = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ${key}=${value})
    .join("&");

  return crypto
    .createHash("sha1")
    .update(stringToSign + process.env.CLOUDINARY_API_SECRET)
    .digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    // Firebase authentication
    const token = getToken(req);

    if (!token) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    let decoded;

    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch {
      return res.status(401).json({
        error: "Invalid authentication token"
      });
    }

    const uid = decoded.uid;

    // Request body
    const { profileImg } = req.body || {};

    if (!profileImg) {
      return res.status(400).json({
        error: "profileImg is required"
      });
    }

    // User document
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    const userData = userSnap.data() || {};
    const currentProfileImg = userData.profileImg || "";

    // Security check:
    // App যে image পাঠাচ্ছে সেটাই user's current image কিনা
    if (currentProfileImg !== profileImg) {
      return res.status(403).json({
        error: "This profile image does not belong to the authenticated user"
      });
    }

    // Cloudinary public ID বের করা
    const publicId = getPublicIdFromCloudinaryUrl(currentProfileImg);

    if (!publicId) {
      return res.status(400).json({
        error: "Cloudinary public ID could not be determined"
      });
    }

    const timestamp = Math.floor(Date.now() / 1000);

    const params = {
      asset_folder: "socialdrop_profile/archive",
      public_id: publicId,
      timestamp,
      type: "upload"
    };

    const signature = createSignature(params);

    const cloudinaryUrl =
      https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/explicit;

    const form = new URLSearchParams();
    form.append("public_id", publicId);
    form.append("type", "upload");
    form.append("asset_folder", "socialdrop_profile/archive");
    form.append("timestamp", String(timestamp));
    form.append("api_key", process.env.CLOUDINARY_API_KEY);
    form.append("signature", signature);

    const cloudinaryResponse = await fetch(cloudinaryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });

    const result = await cloudinaryResponse.json();

    if (!cloudinaryResponse.ok) {
      console.error("Cloudinary archive error:", result);

      return res.status(502).json({
        error: "Cloudinary archive failed",
        detail: result?.error?.message || "Unknown Cloudinary error"
      });
    }

    return res.status(200).json({
      success: true,
      archived: true,
      publicId,
      assetFolder: "socialdrop_profile/archive"
    });

  } catch (error) {
    console.error("archive-profile error:", error);

    return res.status(500).json({
      error: "Profile image archive failed"
    });
  }
}
