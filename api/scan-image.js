// api/scan-image.js
// Sightengine image moderation
// Fail-closed: only an explicitly verified SAFE result is accepted.

const MODELS =
  "nudity-2.1,weapon,recreational_drug,offensive-2.0,gore-2.0";

const THRESHOLDS = {
  sexual_activity: 0.15,
  sexual_display: 0.15,
  erotica: 0.20,
  suggestive: 0.35,
  weapon: 0.40,
  drugs: 0.40,
  offensive: 0.40,
  gore: 0.40,
};

function numberScore(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function result(status, reason, scores = {}) {
  return { status, reason, scores };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json(
      result("ERROR", "Method not allowed")
    );
  }

  const apiUser = process.env.SIGHTENGINE_USER;
  const apiSecret = process.env.SIGHTENGINE_SECRET;

  if (!apiUser || !apiSecret) {
    console.error("Sightengine configuration missing");
    return res.status(500).json(
      result("ERROR", "Server configuration error")
    );
  }

  try {
    const { imageBase64 } = req.body || {};

    if (
      typeof imageBase64 !== "string" ||
      imageBase64.length === 0
    ) {
      return res.status(400).json(
        result("ERROR", "imageBase64 required")
      );
    }

    // Accept raw Base64 or a data:image/...;base64, prefix.
    const match = imageBase64.match(
      /^(?:data:image\/(?:jpeg|jpg|png|webp);base64,)?([A-Za-z0-9+/]+={0,2})$/
    );

    if (!match) {
      return res.status(400).json(
        result("ERROR", "Invalid image encoding")
      );
    }

    const bytes = Buffer.from(match[1], "base64");

    if (
      bytes.length === 0 ||
      bytes.length > 3 * 1024 * 1024
    ) {
      return res.status(413).json(
        result("ERROR", "Image size is invalid or too large")
      );
    }

    // Check that the decoded bytes are actually an image.
    const isJpeg =
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;

    const isPng =
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47,
          0x0d, 0x0a, 0x1a, 0x0a,
        ])
      );

    const isWebp =
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";

    if (!isJpeg && !isPng && !isWebp) {
      return res.status(400).json(
        result("ERROR", "Unsupported or invalid image")
      );
    }

    const form = new FormData();

    form.append(
      "media",
      new Blob([bytes], { type: isJpeg
        ? "image/jpeg"
        : isPng
          ? "image/png"
          : "image/webp"
      }),
      "scan-image"
    );

    form.append("models", MODELS);
    form.append("api_user", apiUser);
    form.append("api_secret", apiSecret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    let response;

    try {
      response = await fetch(
        "https://api.sightengine.com/1.0/check.json",
        {
          method: "POST",
          body: form,
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timer);
    }

    let data;

    try {
      data = await response.json();
    } catch {
      return res.status(502).json(
        result("ERROR", "Invalid moderation response")
      );
    }

    if (!response.ok || data?.status !== "success") {
      // Do not log credentials or image contents.
      console.error("Sightengine request failed", {
        httpStatus: response.status,
        apiErrorCode: data?.error?.code,
        apiErrorType: data?.error?.type,
      });

      return res.status(502).json(
        result("ERROR", "Moderation service failed")
      );
    }

    const nudity = data.nudity;
    const offensive = data.offensive;
    const gore = data.gore;

    const scores = {
      sexual_activity: numberScore(nudity?.sexual_activity),
      sexual_display: numberScore(nudity?.sexual_display),
      erotica: numberScore(nudity?.erotica),
      suggestive: numberScore(nudity?.suggestive),
      weapon: numberScore(data.weapon),
      drugs: numberScore(data.recreational_drug?.prob),
      offensive: numberScore(offensive?.prob),
      gore: numberScore(gore?.prob),
    };

    // Unknown or missing model outputs must not be marked SAFE.
    if (
      scores.sexual_activity === null ||
      scores.sexual_display === null ||
      scores.erotica === null ||
      scores.suggestive === null ||
      scores.weapon === null ||
      scores.drugs === null ||
      scores.offensive === null ||
      scores.gore === null
    ) {
      console.error("Required moderation score missing");
      return res.status(502).json(
        result("REVIEW", "Moderation result incomplete", scores)
      );
    }

    const blocked =
      scores.sexual_activity > THRESHOLDS.sexual_activity ||
      scores.sexual_display > THRESHOLDS.sexual_display ||
      scores.erotica > THRESHOLDS.erotica ||
      scores.suggestive > THRESHOLDS.suggestive ||
      scores.weapon > THRESHOLDS.weapon ||
      scores.drugs > THRESHOLDS.drugs ||
      scores.offensive > THRESHOLDS.offensive ||
      scores.gore > THRESHOLDS.gore;

    if (blocked) {
      return res.status(200).json(
        result("BLOCKED", "Inappropriate content detected", scores)
      );
    }

    return res.status(200).json(
      result("SAFE", "No configured threshold exceeded", scores)
    );
  } catch (error) {
    console.error(
      "Moderation exception:",
      error?.name === "AbortError" ? "Timeout" : "Request failed"
    );

    return res.status(502).json(
      result("ERROR", "Image could not be verified")
    );
  }
}
