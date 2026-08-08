// api/send-otp.js
// OTP তৈরি করে Firestore-এ সেভ করে, তারপর Brevo দিয়ে ইমেইলে পাঠায়।
// সব গোপন key (Firebase Admin, Brevo) শুধু Vercel-এর Environment Variable-এ
// থাকে, ইউজারের অ্যাপ/ব্রাউজারে কখনো যায় না।

import admin from "firebase-admin";

// Firebase Admin একবারই ইনিশিয়ালাইজ করা হচ্ছে (একাধিকবার ইনিশিয়ালাইজ হলে এরর হয়)
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
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "ইমেইল দরকার" });
    }

    // ৬ সংখ্যার র‍্যান্ডম OTP তৈরি
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // ৫ মিনিট পর মেয়াদ শেষ

    // Firestore-এ সেভ (email-কেই ডকুমেন্ট আইডি হিসেবে ব্যবহার করা হচ্ছে,
    // তাই একই ইমেইলে নতুন OTP চাইলে পুরনোটা রিপ্লেস হয়ে যাবে)
    await db.collection("otp_verifications").doc(email).set({
      otp,
      email,
      expiresAt,
      verified: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Brevo দিয়ে ইমেইল পাঠানো
    const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: "Social Drop", email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email }],
        subject: "আপনার OTP কোড - Social Drop",
        htmlContent: `
          <div style="font-family:sans-serif;padding:20px">
            <h2>আপনার ভেরিফিকেশন কোড</h2>
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
