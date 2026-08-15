// api/verify-otp.js
// OTP মিলিয়ে দেখে, purpose অনুযায়ী দুইটা আলাদা কাজের একটা করে:
//  - email_verification → Firebase Auth-এ emailVerified=true করে
//  - password_reset      → Firebase Auth-এ পাসওয়ার্ড বদলে দেয়

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
  });
}
const db = admin.firestore();

const VALID_PURPOSES = ["email_verification", "password_reset"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, otp, uid, newPassword, purpose } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: "email এবং otp দরকার" });
    }
    if (!purpose || !VALID_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "purpose অবশ্যই email_verification অথবা password_reset হতে হবে" });
    }
    if (purpose === "password_reset" && (!newPassword || newPassword.length < 6)) {
      return res.status(400).json({ error: "newPassword দরকার, কমপক্ষে ৬ ক্যারেক্টার" });
    }
    if (purpose === "email_verification" && !uid) {
      return res.status(400).json({ error: "uid দরকার" });
    }

    const docId = `${email}_${purpose}`;
    const docRef = db.collection("otp_verifications").doc(docId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(400).json({ error: "কোনো OTP পাঠানো হয়নি এই ইমেইলে" });
    }

    const data = doc.data();

    if (data.used === true) {
      return res.status(400).json({ error: "এই OTP ইতিমধ্যে ব্যবহার হয়ে গেছে" });
    }
    if (Date.now() > data.expiresAt) {
      return res.status(400).json({ error: "OTP-এর মেয়াদ শেষ হয়ে গেছে, আবার চেষ্টা করুন" });
    }
    if (data.otp !== otp) {
      return res.status(400).json({ error: "OTP মিলছে না" });
    }
    if (data.purpose !== purpose) {
      return res.status(400).json({ error: "এই OTP এই কাজের জন্য প্রযোজ্য না" });
    }

    if (purpose === "email_verification") {
      await admin.auth().updateUser(uid, { emailVerified: true });
    } else {
      const userRecord = await admin.auth().getUserByEmail(email);
      await admin.auth().updateUser(userRecord.uid, { password: newPassword });
    }

    // OTP একবার ব্যবহারের পর অকার্যকর করে দেওয়া হচ্ছে
    await docRef.update({ used: true });

    return res.status(200).json({ success: true });

  } catch (e) {
    if (e.code === "auth/user-not-found") {
      return res.status(400).json({ error: "এই ইমেইলে কোনো একাউন্ট নেই" });
    }
    return res.status(500).json({ error: "সমস্যা হয়েছে", detail: e.message });
  }
}
