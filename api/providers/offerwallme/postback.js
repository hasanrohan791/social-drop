
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  try {
    const secret = process.env.OFFERWALLME_SECRET_KEY;

    if (!secret || !process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.error("Offerwall.me server configuration missing");
      return res.status(500).send("Server configuration error");
    }

    const body = req.body || {};
    const userId = String(body.subId || "");
    const transId = String(body.transId || "");
    const reward = String(body.reward ?? "");
    const signature = String(body.signature || "").toLowerCase();
    const status = String(body.status || "");

    if (
      !userId ||
      !transId ||
      !reward ||
      !/^\d+(\.\d+)?$/.test(reward) ||
      !["1", "2"].includes(status) ||
      !/^[a-f0-9]{32}$/.test(signature)
    ) {
      return res.status(400).send("Invalid parameters");
    }

    const expected = crypto
      .createHash("md5")
      .update(userId + transId + reward + secret, "utf8")
      .digest("hex");

    const receivedBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      return res.status(403).send("Invalid signature");
    }

    const transactionId = crypto
      .createHash("sha256")
      .update(transId)
      .digest("hex");

    const ref = db.collection("offerwallTransactions")
      .doc(transactionId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = admin.firestore.FieldValue.serverTimestamp();

      if (status === "2") {
        // Reversal: never credit a reversed transaction.
        if (snap.exists) {
          tx.update(ref, {
            providerStatus: "reversed",
            reversalReceivedAt: now
          });
        } else {
          tx.create(ref, {
            provider: "offerwallme",
            transId,
            userId,
            reward,
            providerStatus: "reversed",
            adminStatus: "not_approved",
            reversalReceivedAt: now,
            createdAt: now
          });
        }
        return;
      }

      // Duplicate callback: do not create a second reward.
      if (snap.exists) {
        const old = snap.data();

        if (old.providerStatus === "reversed") return;

        if (
          old.userId !== userId ||
          old.reward !== reward
        ) {
          throw new Error("Transaction data mismatch");
        }

        return;
      }

      tx.create(ref, {
        provider: "offerwallme",
        transId,
        userId,
        offerName: String(body.offer_name || ""),
        offerType: String(body.offer_type || ""),
        reward,
        rewardName: String(body.reward_name || ""),
        rewardValue: String(body.reward_value || ""),
        payoutUsd: String(body.payout || ""),
        country: String(body.country || ""),
        providerStatus: "approved",
        adminStatus: "pending",
        walletCredited: false,
        createdAt: now
      });
    });

    return res.status(200).send("ok");
  } catch (error) {
    console.error("Offerwall.me postback error:", error.message);
    return res.status(500).send("Processing failed");
  }
}

