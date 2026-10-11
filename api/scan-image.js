// social-drop/api/scan-image.js
// Live Endpoint: https://social-drop-eight.vercel.app/api/scan-image

import FormData from 'form-data';
import formidable from 'formidable';
import fs from 'fs';

export const config = {
  api: {
    bodyParser: false, // Multipart/form-data হ্যান্ডেল করার জন্য
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const form = formidable({
    keepExtensions: true,
    maxFileSize: 10 * 1024 * 1024,
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('Formidable parse error:', err);
      return res.status(400).json({ status: 'ERROR', error: 'File upload error' });
    }

    try {
      const file = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;
      if (!file) {
        return res.status(400).json({ status: 'ERROR', error: 'No image file uploaded' });
      }

      const apiUser = process.env.SIGHTENGINE_USER;
      const apiSecret = process.env.SIGHTENGINE_SECRET;

      if (!apiUser || !apiSecret) {
        console.error('Missing Sightengine environment variables');
        return res.status(500).json({ status: 'ERROR', error: 'Server configuration error' });
      }

      // Sightengine API-তে সরাসরি ছবি ফাইল পাঠানো
      const formData = new FormData();
      formData.append('media', fs.createReadStream(file.filepath || file.path));
      formData.append('models', 'nudity-2.0,weapon,drugs,offensive,gore-2.0');
      formData.append('api_user', apiUser);
      formData.append('api_secret', apiSecret);

      const response = await fetch('https://api.sightengine.com/1.0/check.json', {
        method: 'POST',
        headers: formData.getHeaders(),
        body: formData,
      });

      const data = await response.json();

      if (data.status === 'success') {
        const nudity = data.nudity || {};
        const isNudity = (nudity.sexual_activity || 0) > 0.40 || (nudity.sexual_display || 0) > 0.40;
        const isWeapon = (data.weapon || 0) > 0.50;
        const isDrugs = (data.drugs || 0) > 0.50;
        const isOffensive = (data.offensive?.prob || 0) > 0.50;
        const isGore = (data.gore?.prob || 0) > 0.50;

        if (isNudity || isWeapon || isDrugs || isOffensive || isGore) {
          return res.status(200).json({
            status: 'BLOCKED',
            reason: 'Inappropriate content detected',
            scores: {
              nudity: Math.max(nudity.sexual_activity || 0, nudity.sexual_display || 0),
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
  });
}
