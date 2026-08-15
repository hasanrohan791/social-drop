// api/send-otp.js
// OTP তৈরি করে Firestore-এ সেভ করে, Brevo দিয়ে ইমেইলে পাঠায়।
// purpose দিয়ে আলাদা করা হয়: "email_verification" বা "password_reset" —
// একটার OTP আরেকটার জন্য ব্যবহার করা যাবে না।

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
    const { email, purpose } = req.body;

    if (!email) {
      return res.status(400).json({ error: "email দরকার" });
    }
    if (!purpose || !VALID_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "purpose অবশ্যই email_verification অথবা password_reset হতে হবে" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // ৫ মিনিট

    // email + purpose মিলিয়ে ডকুমেন্ট আইডি — তাই দুই ধরনের OTP
    // একই ইমেইলের জন্য হলেও একে অপরকে ওভাররাইট করবে না
    const docId = `${email}_${purpose}`;

    await db.collection("otp_verifications").doc(docId).set({
      otp,
      email,
      purpose,
      expiresAt,
      used: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const isVerification = purpose === "email_verification";
    const subject = isVerification
      ? "আপনার ইমেইল ভেরিফিকেশন কোড - Social Drop"
      : "পাসওয়ার্ড রিসেট কোড - Social Drop";
    const heading = isVerification ? "ইমেইল ভেরিফিকেশন কোড" : "পাসওয়ার্ড রিসেট কোড";

    const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: "Social Drop", email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email }],
        subject,
        htmlContent: `
          <div style="font-family:sans-serif;padding:20px">
            <h2>${heading}</h2>
            <p style="font-size:32px;font-weight:bold;letter-spacing:6px">${otp}</p>
            <p>এই কোডটি ৫ মিনিটের জন্য কার্যকর। কাউকে শেয়ার করবেন না।</p>
          </div>
        `
      })
    });

    if (!brevoRes.ok) {
      const errData = await brevoRes.json();
      return res.status(500).json({ error: "ইমেইল পাঠানো যায়নি", detail: errData });
    }

    return res.status(200).json({ success: true });

  } catch (e) {
    return res.status(500).json({ error: "সমস্যা হয়েছে", detail: e.message });
  }
}
