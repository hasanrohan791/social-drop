// api/scan-image.js
// এই ফাইলটা Vercel-এর সার্ভারে চলে, ইউজারের ফোনে/ব্রাউজারে কখনো যায় না।
// Sightengine-এর আসল api_secret এখানেই (Environment Variable হিসেবে) থাকে,
// অ্যাপ/ওয়েবসাইটের কোডে কখনো লেখা হয় না।

export default async function handler(req, res) {
  // শুধু POST রিকোয়েস্ট গ্রহণ করবে
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // ইউজার শুধু ছবির URL পাঠাবে (ছবি নিজে Cloudinary-তে আগেই আপলোড করা থাকবে)
    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ error: "imageUrl দরকার" });
    }

    // Vercel-এর Environment Variables থেকে গোপন key পড়া হচ্ছে (কোডে লেখা না)
    const apiUser = process.env.SIGHTENGINE_USER;
    const apiSecret = process.env.SIGHTENGINE_SECRET;

    const params = new URLSearchParams({
      url: imageUrl,
      models: "nudity-2.0,weapon,recreational_drug,offensive,gore-2.0",
      api_user: apiUser,
      api_secret: apiSecret
    });

    const r = await fetch("https://api.sightengine.com/1.0/check.json?" + params.toString());
    const data = await r.json();

    // ফলাফলটা ফেরত পাঠানো হচ্ছে অ্যাপে (এখানে কোনো secret key নেই)
    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: "স্ক্যান করা যায়নি" });
  }
}
