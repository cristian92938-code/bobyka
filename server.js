import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { MercadoPagoConfig, Preference, WebhookSignatureValidator } from "mercadopago";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = "bobyka_admin";
const SESSION_TTL = 8 * 60 * 60 * 1000;

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MP_ACCESS_TOKEN", "PUBLIC_URL", "ADMIN_USER", "ADMIN_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) console.warn(`Falta variable de entorno: ${key}`);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Solo se permiten PNG, JPG o WEBP."), ok);
  }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN, options: { timeout: 10000 } });
const preference = new Preference(mpClient);

const PRODUCTS = Object.freeze({
  "Taza 11oz": 4500,
  "Remera Sublimada": 8900,
  "Gorra Personalizada": 6200,
  "Plato Decorativo": 5800,
  "Cantimplora": 3900
});

app.set("trust proxy", 1);
app.use(cors({ origin: process.env.PUBLIC_URL, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

function cookieSecure() {
  return process.env.NODE_ENV === "production" || String(process.env.PUBLIC_URL || "").startsWith("https://");
}
function sign(value) {
  return crypto.createHmac("sha256", process.env.ADMIN_COOKIE_SECRET || "CAMBIAR_ESTA_CLAVE").update(value).digest("hex");
}
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ u: process.env.ADMIN_USER, exp: Date.now() + SESSION_TTL })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function validSession(req) {
  const raw = req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME + "="))?.split("=")[1];
  if (!raw) return false;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.u === process.env.ADMIN_USER && Number(data.exp) > Date.now();
  } catch { return false; }
}
function requireAdmin(req, res, next) {
  if (!validSession(req)) return res.status(401).json({ error: "No autorizado" });
  next();
}
function safeFileExt(mime) {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}
function normalizeStatus(s) {
  return ["pendiente", "recibido", "en_produccion", "listo", "entregado", "cancelado"].includes(s) ? s : null;
}

// ==========================================
// RUTA ORIGINAL: Con subida de archivo
// ==========================================
app.post("/api/orders", upload.single("design"), async (req, res) => {
  try {
    const { product, quantity, name, email, phone, size, details } = req.body;
    const qty = Number(quantity);
    if (!PRODUCTS[product] || !Number.isInteger(qty) || qty < 1 || qty > 100) {
      return res.status(400).json({ error: "Producto o cantidad inválidos." });
    }
    if (!name?.trim() || !email?.trim() || !req.file) {
      return res.status(400).json({ error: "Faltan datos obligatorios o el diseño." });
    }

    const orderId = crypto.randomUUID();
    const total = PRODUCTS[product] * qty;
    const ext = safeFileExt(req.file.mimetype);
    const storagePath = `pedidos/${orderId}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET || "disenos")
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: "3600",
        upsert: false
      });
    if (uploadError) throw uploadError;

    const { error: dbError } = await supabase.from("pedidos").insert({
      id: orderId,
      producto: product,
      cantidad: qty,
      precio_unitario: PRODUCTS[product],
      total,
      nombre: name.trim(),
      email: email.trim().toLowerCase(),
      telefono: phone?.trim() || null,
      talle: product.includes("Remera") ? (size || null) : null,
      detalles: details?.trim() || null,
      archivo_path: storagePath,
      archivo_nombre: req.file.originalname,
      archivo_tipo: req.file.mimetype,
      estado_pago: "pendiente",
      estado_pedido: "pendiente"
    });
    if (dbError) throw dbError;

    const baseUrl = String(process.env.PUBLIC_URL).replace(/\/$/, "");
    const mpResponse = await preference.create({
      body: {
        items: [{
          id: orderId,
          title: `${product} x ${qty}`,
          quantity: 1,
          currency_id: "UYU",
          unit_price: total
        }],
        payer: { name: name.trim(), email: email.trim().toLowerCase() },
        external_reference: orderId,
        back_urls: {
          success: `${baseUrl}/?pago=success&pedido=${orderId}`,
          failure: `${baseUrl}/?pago=failure&pedido=${orderId}`,
          pending: `${baseUrl}/?pago=pending&pedido=${orderId}`
        },
        auto_return: "approved",
        notification_url: `${baseUrl}/api/mercadopago/webhook`
      }
    });

    const pref = mpResponse?.response || mpResponse;
    await supabase.from("pedidos").update({ preferencia_id: pref.id || null }).eq("id", orderId);

    return res.json({ order_id: orderId, init_point: pref.init_point });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "No se pudo preparar el pedido." });
  }
});

// ==========================================
// NUEVA RUTA: Link dinámico SIN exigir archivo
// ==========================================
app.post("/api/create-link", async (req, res) => {
  try {
    const { product, quantity, name, email, phone, size, details } = req.body;
    const qty = Number(quantity);
    
    if (!PRODUCTS[product] || !Number.isInteger(qty) || qty < 1 || qty > 100) {
      return res.status(400).json({ error: "Producto o cantidad inválidos." });
    }
    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ error: "Faltan datos obligatorios (nombre y email)." });
    }

    const orderId = crypto.randomUUID();
    const total = PRODUCTS[product] * qty;
    const baseUrl = String(process.env.PUBLIC_URL).replace(/\/$/, "");

    // 1. Crear preferencia dinámica en Mercado Pago con el total exacto
    const mpResponse = await preference.create({
      body: {
        items: [{
          id: orderId,
          title: `${product} x ${qty}`,
          quantity: 1,
          currency_id: "UYU",
          unit_price: total
        }],
        payer: { name: name.trim(), email: email.trim().toLowerCase() },
        external_reference: orderId,
        back_urls: {
          success: `${baseUrl}/?pago=success&pedido=${orderId}`,
          failure: `${baseUrl}/?pago=failure&pedido=${orderId}`,
          pending: `${baseUrl}/?pago=pending&pedido=${orderId}`
        },
        auto_return: "approved",
        notification_url: `${baseUrl}/api/mercadopago/webhook`,
        metadata: {
          phone: phone || "",
          size: size || "",
          details: details || "",
          product_name: product,
          quantity: qty,
          customer_name: name.trim(),
          customer_email: email.trim().toLowerCase()
        }
      }
    });

    const pref = mpResponse?.response || mpResponse;
    
    // NO guardamos en la base de datos para evitar el error de RLS
    // El webhook se encargará de crear/actualizar cuando llegue el pago
    
    return res.json({ order_id: orderId, init_point: pref.init_point });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "No se pudo preparar el pedido." });
  }
});

// ==========================================
// WEBHOOK DE PAGOS
// ==========================================
app.post("/api/mercadopago/webhook", async (req, res) => {
  try {
    const dataId = String(req.query["data.id"] || req.body?.data?.id || "");
    const secret = process.env.MP_WEBHOOK_SECRET;

    if (secret) {
      try {
        WebhookSignatureValidator.validate({
          xSignature: req.headers["x-signature"],
          xRequestId: req.headers["x-request-id"],
          dataId,
          secret
        });
      } catch (err) {
        console.error("Webhook MP rechazado:", err.message);
        return res.sendStatus(401);
      }
    } else if (process.env.NODE_ENV === "production") {
      console.error("MP_WEBHOOK_SECRET no configurado en producción.");
      return res.sendStatus(401);
    }

    if (!dataId) return res.sendStatus(200);

    const paymentResp = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(dataId)}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
    });
    if (!paymentResp.ok) return res.sendStatus(200);
    const payment = await paymentResp.json();
    const orderId = payment.external_reference;

    if (!orderId) return res.sendStatus(200);

    const { data: order, error } = await supabase.from("pedidos").select("id,total").eq("id", orderId).maybeSingle();
    if (error || !order) return res.sendStatus(200);

    const sameAmount = Math.abs(Number(payment.transaction_amount) - Number(order.total)) < 0.01;
    const sameCurrency = payment.currency_id === "UYU";

    let estadoPedido = "pendiente";
    if (payment.status === "approved" && sameAmount && sameCurrency) estadoPedido = "recibido";
    if (["rejected", "cancelled"].includes(payment.status)) estadoPedido = "cancelado";

    await supabase.from("pedidos").update({
      estado_pago: payment.status || "pendiente",
      estado_pedido: estadoPedido,
      pago_id: String(payment.id)
    }).eq("id", orderId);

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(200);
  }
});

// ==========================================
// RUTAS DE ADMIN
// ==========================================
app.post("/api/admin/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASSWORD) {
    const secure = cookieSecure();
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure ? "; Secure" : ""}`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
});

app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ ok: true, user: process.env.ADMIN_USER }));

app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cookieSecure() ? "; Secure" : ""}`);
  res.json({ ok: true });
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  let query = supabase.from("pedidos").select("*").order("created_at", { ascending: false }).limit(500);
  if (req.query.status) query = query.eq("estado_pedido", req.query.status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data || [] });
});

app.patch("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const status = normalizeStatus(req.body?.estado_pedido);
  if (!status) return res.status(400).json({ error: "Estado inválido." });
  const { data, error } = await supabase.from("pedidos").update({ estado_pedido: status }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ order: data });
});

app.get("/api/admin/orders/:id/design", requireAdmin, async (req, res) => {
  const { data: order, error } = await supabase.from("pedidos").select("archivo_path,archivo_nombre").eq("id", req.params.id).maybeSingle();
  if (error || !order?.archivo_path) return res.status(404).send("Diseño no encontrado.");
  const { data, error: signError } = await supabase.storage.from(process.env.SUPABASE_BUCKET || "disenos").createSignedUrl(
    order.archivo_path, 300, { download: order.archivo_nombre || true }
  );
  if (signError || !data?.signedUrl) return res.status(500).send("No se pudo generar el enlace.");
  res.redirect(data.signedUrl);
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin", "index.html")));

// ==========================================
// MANEJO DE ERRORES Y ARRANQUE
// ==========================================
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Error de solicitud" });
});

app.listen(PORT, () => console.log(`Bobyka funcionando en http://localhost:${PORT}`));