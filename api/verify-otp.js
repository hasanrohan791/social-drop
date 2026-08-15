import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const {
      email,
      otp,
      newPassword,
      purpose,
      uid,
    } = req.body || {};

    // -----------------------------------------
    // 1. Basic validation
    // -----------------------------------------

    if (!email  !otp  !purpose) {
      return res.status(400).json({
        error: "ইমেইল, OTP এবং purpose প্রয়োজন",
      });
    }

    if (
      purpose !== "email_verification" &&
      purpose !== "password_reset"
    ) {
      return res.status(400).json({
        error: "অবৈধ OTP purpose",
      });
    }

    // -----------------------------------------
    // 2. Get OTP document
    // -----------------------------------------

    const docRef = db
      .collection("otp_verifications")
      .doc(email);

    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(400).json({
        error: "কোনো OTP পাওয়া যায়নি",
      });
    }

    const data = doc.data();

    // -----------------------------------------
    // 3. Expiry check
    // -----------------------------------------

    if (!data.expiresAt || Date.now() > data.expiresAt) {
      await docRef.delete();

      return res.status(400).json({
        error: "OTP-এর মেয়াদ শেষ হয়ে গেছে",
      });
    }

    // -----------------------------------------
    // 4. Purpose check
    // -----------------------------------------

    if (data.purpose !== purpose) {
      return res.status(400).json({
        error: "এই OTP অন্য কাজের জন্য তৈরি করা হয়েছে",
      });
    }

    // -----------------------------------------
    // 5. OTP check
    // -----------------------------------------

    if (data.otp !== otp) {
      return res.status(400).json({
        error: "ভুল OTP",
      });
    }

    // =========================================
    // EMAIL VERIFICATION
    // =========================================

    if (purpose === "email_verification") {
      if (!uid) {
        return res.status(400).json({
          error: "User UID প্রয়োজন",
        });
      }

      // UID থেকে Firebase Auth user নেওয়া
      const userRecord = await admin.auth().getUser(uid);

      // Request-এর email এবং UID-এর email একই কিনা যাচাই
      if (
        !userRecord.email ||
        userRecord.email.toLowerCase() !== email.toLowerCase()
      ) {
        return res.status(400).json({
          error: "ইমেইল এবং User UID মিলে না",
        });
      }

      // Firebase Authentication
      await admin.auth().updateUser(uid, {
        emailVerified: true,
      });

      // Firestore
      await db
        .collection("users")
        .doc(uid)
        .set(
          {
            emailVerified: true,
          },
          {
            merge: true,
          }
        );

      // OTP একবার ব্যবহার হওয়ার পর delete
      await docRef.delete();

      return res.status(200).json({
        success: true,
        purpose: "email_verification",
        message: "ইমেইল সফলভাবে ভেরিফাই হয়েছে",
      });
    }

    // =========================================
    // PASSWORD RESET
    // =========================================

    if (purpose === "password_reset") {
      if (!newPassword) {
        return res.status(400).json({
          error: "নতুন পাসওয়ার্ড প্রয়োজন",
        });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({
          error: "পাসওয়ার্ড কমপক্ষে ৬ ক্যারেক্টার হতে হবে",
        });
      }

      const userRecord =
        await admin.auth().getUserByEmail(email);

      await admin.auth().updateUser(userRecord.uid, {
        password: newPassword,
      });

      // OTP একবার ব্যবহার হওয়ার পর delete
      await docRef.delete();

    return res.status(200).json({
        success: true,
        purpose: "password_reset",
        message: "পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে",
      });
    }

    return res.status(400).json({
      error: "অজানা OTP purpose",
    });
  } catch (e) {
    console.error("Verify OTP Error:", e);

    if (e.code === "auth/user-not-found") {
      return res.status(400).json({
        error: "এই ইমেইলে কোনো একাউন্ট নেই",
      });
    }

    return res.status(500).json({
      error: "অভ্যন্তরীণ সমস্যা",
      detail: e.message,
    });
  }
}
