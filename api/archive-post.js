// api/archive-post.js

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

function createSignature(params) {
  const stringToSign = Object.entries(params)
    .filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        value !== ""
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto
    .createHash("sha1")
    .update(
      stringToSign + process.env.CLOUDINARY_API_SECRET
    )
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
    const { postId } = req.body || {};

    if (!postId) {
      return res.status(400).json({
        error: "postId is required"
      });
    }

    // Post document
    const postRef = db.collection("posts").doc(postId);
    const postSnap = await postRef.get();

    if (!postSnap.exists) {
      return res.status(404).json({
        error: "Post not found"
      });
    }

    const postData = postSnap.data() || {};

    // Security check
    if (postData.uid !== uid) {
      return res.status(403).json({
        error: "You do not own this post"
      });
    }

    // Text-only post
    // No Cloudinary archive is needed.
    const publicId = postData.publicId || "";

    if (!publicId) {
      return res.status(200).json({
        success: true,
        archived: false,
        textOnly: true
      });
    }

    // Cloudinary archive
    const timestamp = Math.floor(Date.now() / 1000);

    const params = {
      asset_folder: "socialdrop_posts/archive",
      public_id: publicId,
      timestamp,
      type: "upload"
    };

    const signature = createSignature(params);

    const cloudinaryUrl =
      `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/explicit`;

    const form = new URLSearchParams();

    form.append("public_id", publicId);
    form.append("type", "upload");
    form.append(
      "asset_folder",
      "socialdrop_posts/archive"
    );
    form.append(
      "timestamp",
      String(timestamp)
    );
    form.append(
      "api_key",
      process.env.CLOUDINARY_API_KEY
    );
    form.append(
      "signature",
      signature
    );

    const cloudinaryResponse = await fetch(
      cloudinaryUrl,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: form
      }
    );

    const result = await cloudinaryResponse.json();

    if (!cloudinaryResponse.ok) {
      console.error(
        "Cloudinary post archive error:",
        result
      );

      return res.status(502).json({
        error: "Cloudinary archive failed",
        detail:
          result?.error?.message ||
          "Unknown Cloudinary error"
      });
    }

    return res.status(200).json({
      success: true,
      archived: true,
      publicId,
      assetFolder:
        "socialdrop_posts/archive"
    });
  } catch (error) {
    console.error(
      "archive-post error:",
      error
    );

    return res.status(500).json({
      error: "Post image archive failed"
    });
  }
}
