import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import url from 'url';
// ya no usamos Google Drive; usaremos Cloudinary
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';

// Cargar .env si existe
dotenv.config();

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const app = express();
const UPLOAD_DIR = 'uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Límite por archivo (MB) configurable vía env, default 50MB
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const upload = multer({ dest: `${UPLOAD_DIR}/`, limits: { fileSize: MAX_FILE_SIZE } });
const PORT = process.env.PORT || 3000;

// CORS
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN && process.env.FRONTEND_ORIGIN.trim();
if (FRONTEND_ORIGIN) {
  console.log(`🔒 Restringiendo CORS a: ${FRONTEND_ORIGIN}`);
  app.use(cors({ origin: FRONTEND_ORIGIN }));
} else {
  app.use(cors());
}
app.use(express.json());

// servir estáticos
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// health
app.get('/health', (req, res) => res.json({ ok: true, env: { frontend: FRONTEND_ORIGIN || null } }));

// Configurar Cloudinary desde variables de entorno
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Comprobar configuración mínima (no imprimir valores sensibles)
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn('⚠️ Cloudinary no está completamente configurado. Revisa las variables de entorno CLOUDINARY_*');
}

// Nota: ya no usamos Google Drive ni OAuth; el upload va directo a Cloudinary

// upload
app.post('/upload', upload.single('file'), async (req, res) => {
  const guestName = req.body.guestName || '';
  if (!guestName) return res.status(400).json({ error: 'guestName faltante' });
  if (!req.file) return res.status(400).json({ error: 'Archivo faltante' });

  const tempPath = req.file.path;
  try {
    const mainFolder = process.env.CLOUDINARY_FOLDER || 'wedding_photos';
    const sanitized = guestName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const uploadFolder = `${mainFolder}/${sanitized}`;

    const result = await cloudinary.uploader.upload(tempPath, {
      folder: uploadFolder,
      resource_type: 'auto',
      use_filename: true,
      unique_filename: false,
      overwrite: false,
    });

    // cleanup temp
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }

    // Responder con campos seguros (no reenviamos el objeto raw completo)
    res.json({ success: true, file: { public_id: result.public_id, url: result.secure_url } });
  } catch (err) {
    // Generar un id corto para correlación y no filtrar el mensaje original al cliente
    const errorId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

    // función para redacción de secretos en mensajes
    const redact = (s) => {
      if (!s) return s;
      let out = String(s);
      try {
        if (process.env.CLOUDINARY_API_KEY) {
          out = out.split(process.env.CLOUDINARY_API_KEY).join('[REDACTED_API_KEY]');
        }
      } catch (e) { /* ignore */ }
      return out;
    };

    // construir entrada de log (sin secretos)
    const logPath = path.join(__dirname, 'upload_errors.log');
    const logEntry = {
      id: errorId,
      ts: new Date().toISOString(),
      guestName: req.body && req.body.guestName ? String(req.body.guestName) : null,
      originalName: req.file && req.file.originalname ? String(req.file.originalname) : null,
      message: redact(err && err.message ? err.message : String(err)),
      stack: redact(err && err.stack ? err.stack : null)
    };

    try {
      fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
    } catch (e) {
      console.error('No se pudo escribir upload_errors.log:', e && e.message ? e.message : e);
    }

    // log seguro en consola (mensaje redacted)
    console.error(`Cloudinary upload error [id=${errorId}]:`, logEntry.message);

    if (tempPath && fs.existsSync(tempPath)) { try { fs.unlinkSync(tempPath); } catch (e) {} }
    // Respuesta genérica al cliente (evita filtrar claves/errores sensibles)
    res.status(500).json({ success: false, error: 'Error al subir el archivo. Contacta al administrador con el id: ' + errorId, id: errorId });
  }
});

// Manejo de errores de multer (p. ej. límite de tamaño)
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: `Archivo demasiado grande. Tamaño máximo por archivo: ${MAX_FILE_SIZE_MB} MB` });
    }
    return res.status(400).json({ success: false, error: 'Error en la carga del archivo: ' + err.message });
  }
  return next(err);
});

// start
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`));

