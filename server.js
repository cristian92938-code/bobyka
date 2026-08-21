require('dotenv').config();
const express = require('express');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Multer para recibir archivos (máximo 10MB)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } 
});

// Configuración de Mercado Pago (SDK v2)
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const mpPreference = new Preference(mpClient);
const mpPayment = new Payment(mpClient);

// Configuración de Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Servir archivos estáticos (tu HTML, CSS, etc.)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Lista de precios (validación de seguridad)
const PRODUCTS = {
  'Remera Sublimada': 430,
  'Taza 11oz': 250,
  'Gorra Personalizada': 250,
  'Plato Decorativo': 510,
  'Cantimplora': 390
};

// RUTA PRINCIPAL: Crear pedido + Subir archivo + Generar link de MP
app.post('/api/orders', upload.single('design'), async (req, res) => {
  try {
    const { product, quantity, name, email, phone, size, details } = req.body;
    const qty = parseInt(quantity) || 1;
    
    if (!PRODUCTS[product]) {
      return res.status(400).json({ error: 'Producto no válido' });
    }
    
    const total = PRODUCTS[product] * qty;
    let designUrl = null;

    if (req.file) {
      const fileExt = req.file.originalname.split('.').pop();
      const fileName = `${Date.now()}-${name.replace(/\s+/g, '_')}.${fileExt}`;
      const filePath = `designs/${fileName}`;
      
      const { error: uploadError } = await supabase
        .storage
        .from('disenos')
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });
      
      if (uploadError) {
        console.error('Error subiendo archivo a Supabase:', uploadError);
        return res.status(500).json({ error: 'Error al subir el diseño' });
      }
      
      const { data: urlData } = supabase
        .storage
        .from('disenos')
        .getPublicUrl(filePath);
      
      designUrl = urlData.publicUrl;
    }

    const { data: order, error: dbError } = await supabase
      .from('orders')
      .insert([{
        product,
        quantity: qty,
        total,
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        size: size || null,
        details: details || null,
        design_url: designUrl,
        status: 'pending',
        created_at: new Date().toISOString()
      }])
      .select()
      .single();
    
    if (dbError) {
      console.error('Error guardando pedido en BD:', dbError);
      return res.status(500).json({ error: 'Error al guardar el pedido' });
    }

    const preferenceBody = {
      items: [{
        title: `${product} x${qty}`,
        quantity: 1,
        currency_id: 'UYU',
        unit_price: total
      }],
      payer: {
        name: name,
        email: email
      },
      back_urls: {
        success: `${process.env.PUBLIC_URL}/`,
        failure: `${process.env.PUBLIC_URL}/`,
        pending: `${process.env.PUBLIC_URL}/`
      },
      auto_return: 'approved',
      notification_url: `${process.env.PUBLIC_URL}/api/webhook`
    };

    const mpResponse = await mpPreference.create({ body: preferenceBody });

    if (!mpResponse.init_point) {
      return res.status(500).json({ error: 'Error creando preferencia de pago' });
    }

    await supabase
      .from('orders')
      .update({ payment_url: mpResponse.init_point })
      .eq('id', order.id);

    res.json({
      success: true,
      init_point: mpResponse.init_point,
      orderId: order.id
    });

  } catch (error) {
    console.error('Error general en /api/orders:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// RUTA WEBHOOK
app.post('/api/webhook', express.json(), async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type === 'payment') {
      const paymentId = data.id;
      const paymentInfo = await mpPayment.get({ id: paymentId });
      const status = paymentInfo.status;

      if (status === 'approved') {
        console.log(`Pago aprobado! ID: ${paymentId}`);
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).send('Error');
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});