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
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, purpose } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "ইমেইল প্রয়োজন" });
    }

    if (
      purpose !== "email_verification" &&
      purpose !== "password_reset"
    ) {
      return res.status(400).json({
        error: "সঠিক OTP purpose প্রয়োজন",
      });
    }

    const otp = Math.floor(
      100000 + Math.random() * 900000
    ).toString();

    const expiresAt = Date.now() + 5 * 60 * 1000;

    await db.collection("otp_verifications").doc(email).set({
      otp,
      email,
      purpose,
      expiresAt,
      verified: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const subject =
      purpose === "email_verification"
        ? "ইমেইল ভেরিফিকেশন কোড - Social Drop"
        : "পাসওয়ার্ড রিসেট কোড - Social Drop";

    const message =
      purpose === "email_verification"
        ? "আপনার Social Drop ইমেইল ভেরিফিকেশন কোড:"
        : "আপনার Social Drop পাসওয়ার্ড রিসেট কোড:";

    const brevoRes = await fetch(
      "https://api.brevo.com/v3/smtp/email",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": process.env.BREVO_API_KEY,
        },
        body: JSON.stringify({
          sender: {
            name: "Social Drop",
            email: process.env.BREVO_SENDER_EMAIL,
          },
          to: [{ email }],
          subject,
          htmlContent: 
            <div style="font-family:sans-serif;padding:20px;text-align:center">
              <h2>Social Drop</h2>
              <p>${message}</p>

              <p style="
                font-size:32px;
                font-weight:bold;
                letter-spacing:8px;
                color:#0EA5E9;
              ">
                ${otp}
              </p>

              <p>
                এই কোডটি ৫ মিনিটের জন্য কার্যকর।
              </p>

              <p>
                নিরাপত্তার স্বার্থে কোডটি কাউকে শেয়ার করবেন না।
              </p>
            </div>
          ,
        }),
      }
    );

    if (!brevoRes.ok) {
      const errorText = await brevoRes.text();

      return res.status(500).json({
        error: "ইমেইল পাঠানো যায়নি",
        detail: errorText,
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP পাঠানো হয়েছে",
    });
  } catch (e) {
    console.error("Send OTP Error:", e);

    return res.status(500).json({
      error: "সমস্যা হয়েছে",
      detail: e.message,
    });
  }
}
