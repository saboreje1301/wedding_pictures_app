import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { google } from "googleapis";
import path from 'path';
import url from 'url';

const app = express();
const UPLOAD_DIR = "uploads";
// Asegurarnos de que exista la carpeta de uploads
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const upload = multer({ dest: `${UPLOAD_DIR}/` });
const PORT = process.env.PORT || 3000;

// === Middlewares ===
app.use(cors());
app.use(express.json());

// Resolver __dirname en ESM
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Servir archivos estáticos (index.html, hero.png, etc.) desde la raíz del proyecto
app.use(express.static(path.join(__dirname)));

// Ruta raíz — enviar index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// === Configurar Google OAuth ===
let oAuth2Client = null;
try {
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || "credentials.json";
  const resolved = path.resolve(process.cwd(), credentialsPath);
  console.log(`🔎 Buscando credentials en: ${resolved}`);
  if (!fs.existsSync(resolved)) throw new Error(`${resolved} no encontrado`);
  const raw = fs.readFileSync(resolved, { encoding: 'utf8' });
  const credentials = JSON.parse(raw);

  // Algunas descargas de Google usan 'installed' o 'web'
  const conf = credentials.installed || credentials.web || credentials;
  const { client_secret, client_id, redirect_uris } = conf;
  if (!client_id || !client_secret || !redirect_uris) throw new Error('credentials.json inválido (falta client_id/client_secret/redirect_uris)');

  oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  console.log('✅ credentials.json cargado correctamente');
} catch (err) {
  console.warn("⚠️ No se pudo cargar credentials.json. Rutas de autenticación estarán limitadas.\n", err && err.message ? err.message : err);
}

// === Intentar cargar token existente ===
if (oAuth2Client && fs.existsSync("token.json")) {
  try {
    const token = JSON.parse(fs.readFileSync("token.json"));
    oAuth2Client.setCredentials(token);
    console.log("✅ Token de acceso cargado");
  } catch (err) {
    console.warn("⚠️ Error cargando token.json:", err.message);
  }
} else if (oAuth2Client) {
  console.log("⚠️ No se encontró token.json. Autentícate en /auth una vez.");
} else {
  console.log("⚠️ OAuth no configurado. Coloca un credentials.json para habilitar Google Drive.");
}

// === Ruta para iniciar autenticación manual (solo tú la usas) ===
app.get("/auth", (req, res) => {
  if (!oAuth2Client) return res.status(500).send("credentials.json no configurado en el servidor");
  // Forzar selector de cuenta para permitir cambiar sesión en la pantalla de Google
  // Si pasas ?force=1 usaremos prompt 'consent select_account' para forzar selector + consentimiento
  const shouldForce = String(req.query.force || '') === '1';
  const promptValue = req.query.prompt || (shouldForce ? 'consent select_account' : 'select_account');

  const opts = {
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/drive.file"],
    prompt: promptValue,
    include_granted_scopes: true,
  };
  // Opcional: aceptar login_hint como query param para sugerir cuenta
  if (req.query.login_hint) opts.login_hint = req.query.login_hint;
  // Opcional: aceptar authuser para forzar índice de cuenta
  if (req.query.authuser) opts.authuser = req.query.authuser;
  const authUrl = oAuth2Client.generateAuthUrl(opts);
  console.log('🔗 URL de autorización generada:', authUrl);
  res.redirect(authUrl);
});

// === Callback que guarda el token ===
app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;
  try {
    if (!oAuth2Client) return res.status(500).send("OAuth no configurado. No hay credentials.json");
    if (!code) return res.status(400).send("Código de autorización faltante");
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync("token.json", JSON.stringify(tokens));
    res.send("✅ Autenticación completada. Puedes cerrar esta pestaña.");
  } catch (error) {
    console.error(error);
    res.status(500).send("❌ Error al autenticar");
  }
});

// === Subida de archivos ===
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!oAuth2Client) return res.status(500).json({ error: "OAuth no configurado en el servidor" });
  let tempPath;
  try {
    const { guestName } = req.body;
    if (!guestName) return res.status(400).json({ error: "guestName faltante" });
    if (!req.file) return res.status(400).json({ error: "Archivo faltante" });

    tempPath = req.file.path;

    const drive = google.drive({ version: "v3", auth: oAuth2Client });

    // Buscar o crear carpeta principal
    const mainFolder = "Fotos_Boda";
    const folderRes = await drive.files.list({
      q: `name='${mainFolder}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id)",
    });

    let folderId = folderRes.data.files.length
      ? folderRes.data.files[0].id
      : (
          await drive.files.create({
            resource: {
              name: mainFolder,
              mimeType: "application/vnd.google-apps.folder",
            },
            fields: "id",
          })
        ).data.id;

    // Subcarpeta por invitado
    const sanitizedName = guestName.replace(/[^a-zA-Z0-9]/g, "_");
    const guestFolderRes = await drive.files.list({
      q: `name='${sanitizedName}' and '${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id)",
    });

    const guestFolderId = guestFolderRes.data.files.length
      ? guestFolderRes.data.files[0].id
      : (
          await drive.files.create({
            resource: {
              name: sanitizedName,
              mimeType: "application/vnd.google-apps.folder",
              parents: [folderId],
            },
            fields: "id",
          })
        ).data.id;

    // Subir archivo
    const fileMetadata = {
      name: `${Date.now()}_${req.file.originalname}`,
      parents: [guestFolderId],
    };
    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path),
    };

    const result = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: "id, name, webViewLink",
    });

    // eliminar temporal
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

    res.json({
      success: true,
      file: result.data,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    // intentar limpiar temporal en caso de error
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }
  }
});

// === Iniciar servidor ===
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
