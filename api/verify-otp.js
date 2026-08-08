// api/verify-otp.js
// OTP মিলিয়ে দেখে, ঠিক থাকলে ও মেয়াদ শেষ না হলে পাসওয়ার্ড বদলে দেয়।

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
  });
}
const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: "email, otp, newPassword — সবগুলো দরকার" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "পাসওয়ার্ড কমপক্ষে ৬ ক্যারেক্টার হতে হবে" });
    }

    const docRef = db.collection("otp_verifications").doc(email);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(400).json({ error: "কোনো OTP পাঠানো হয়নি এই ইমেইলে" });
    }

    const data = doc.data();

    if (Date.now() > data.expiresAt) {
      return res.status(400).json({ error: "OTP-এর মেয়াদ শেষ হয়ে গেছে, আবার চেষ্টা করুন" });
    }

    if (data.otp !== otp) {
      return res.status(400).json({ error: "OTP মিলছে না" });
    }

    // OTP সঠিক — এখন Firebase Auth-এ পাসওয়ার্ড বদলানো হচ্ছে
    const userRecord = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(userRecord.uid, { password: newPassword });

    // ব্যবহার হয়ে যাওয়া OTP মুছে ফেলা হচ্ছে (আবার ব্যবহার ঠেকাতে)
    await docRef.delete();

    return res.status(200).json({ success: true });

  } catch (e) {
    if (e.code === "auth/user-not-found") {
      return res.status(400).json({ error: "এই ইমেইলে কোনো একাউন্ট নেই" });
    }
    return res.status(500).json({ error: "সমস্যা হয়েছে", detail: e.message });
  }
}
