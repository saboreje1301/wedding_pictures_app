const crypto = require('crypto');

// Netlify Function: firma parámetros para subida segura a Cloudinary
// Espera query param: guestName (opcional). Devuelve { api_key, timestamp, signature, cloud_name, folder }

exports.handler = async function (event) {
  try {
    const env = process.env;
    const CLOUD_NAME = env.CLOUDINARY_CLOUD_NAME;
    const API_KEY = env.CLOUDINARY_API_KEY;
    const API_SECRET = env.CLOUDINARY_API_SECRET;
    const BASE_FOLDER = env.CLOUDINARY_FOLDER || 'wedding_photos';

    if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Cloudinary no configurado en el servidor (faltan env vars)' })
      };
    }

    const qs = event.queryStringParameters || {};
    const guestName = qs.guestName ? String(qs.guestName).trim() : '';
    const sanitize = (s) => (s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const sanitized = sanitize(guestName) || 'anonymous';
    const folder = `${BASE_FOLDER}/${sanitized}`;

    const timestamp = Math.floor(Date.now() / 1000);
    // params must be ordered lexicographically by key when signing
    const toSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature = crypto.createHash('sha1').update(toSign + API_SECRET).digest('hex');

    return {
      statusCode: 200,
      body: JSON.stringify({ api_key: API_KEY, timestamp, signature, cloud_name: CLOUD_NAME, folder })
    };
  } catch (err) {
    console.error('Error en sign function:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
