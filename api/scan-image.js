// social-drop/api/scan-image.js
// Live Endpoint: https://social-drop-eight.vercel.app/api/scan-image

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiUser = process.env.SIGHTENGINE_USER;
    const apiSecret = process.env.SIGHTENGINE_SECRET;

    if (!apiUser || !apiSecret) {
      console.error('Missing Sightengine environment variables');
      return res.status(500).json({ status: 'ERROR', error: 'Server configuration error' });
    }

    const { imageBase64 } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ status: 'ERROR', error: 'imageBase64 required' });
    }

    // Direct Binary Media Stream to Sightengine API
    const formData = new FormData();
    const blob = new Blob([Buffer.from(imageBase64, 'base64')], { type: 'image/jpeg' });
    formData.append('media', blob, 'scan_image.jpg');
    formData.append('models', 'nudity-2.0,weapon,drugs,offensive,gore-2.0');
    formData.append('api_user', apiUser);
    formData.append('api_secret', apiSecret);

    const response = await fetch('https://api.sightengine.com/1.0/check.json', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();

    if (data.status === 'success') {
      const nudity = data.nudity || {};

      // Strict Inversion Rule: 1.0 - none gives total nudity/suggestiveness probability
      const noneScore = nudity.none !== undefined ? nudity.none : 1.0;
      const totalNudityProb = 1.0 - noneScore;

      const isNudity = totalNudityProb > 0.20 ||
                       (nudity.sexual_activity || 0) > 0.15 ||
                       (nudity.sexual_display || 0) > 0.15 ||
                       (nudity.erotica || 0) > 0.20 ||
                       (nudity.very_suggestive || 0) > 0.25 ||
                       (nudity.suggestive || 0) > 0.35;

      const isWeapon = (data.weapon || 0) > 0.40;
      const isDrugs = (data.drugs || 0) > 0.40;
      const isOffensive = (data.offensive?.prob || 0) > 0.40;
      const isGore = (data.gore?.prob || 0) > 0.40;

      if (isNudity || isWeapon || isDrugs || isOffensive || isGore) {
        return res.status(200).json({
          status: 'BLOCKED',
          reason: 'Inappropriate content detected',
          scores: {
            nudity: totalNudityProb,
            sexual_activity: nudity.sexual_activity || 0,
            sexual_display: nudity.sexual_display || 0,
            weapon: data.weapon || 0,
            drugs: data.drugs || 0,
            offensive: data.offensive?.prob || 0,
            gore: data.gore?.prob || 0
          }
        });
      }

      return res.status(200).json({ status: 'SAFE' });
    } else {
      return res.status(200).json({
        status: 'REVIEW',
        reason: data.error?.message || 'Scan evaluation error'
      });
    }
  } catch (e) {
    console.error('Scan exception:', e);
    return res.status(500).json({ status: 'ERROR', error: 'Moderation scan failed' });
  }
}
