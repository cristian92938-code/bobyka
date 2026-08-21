require('dotenv').config();
const express = require('express');
const mercadopago = require('mercadopago');
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

// Configuración de Mercado Pago
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

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
    
    // 1. Validar que el producto exista y tenga precio
    if (!PRODUCTS[product]) {
      return res.status(400).json({ error: 'Producto no válido' });
    }
    
    const total = PRODUCTS[product] * qty;
    let designUrl = null;

    // 2. Si el cliente subió un archivo, lo guardamos en Supabase
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
      
      // Obtener el link público del archivo
      const { data: urlData } = supabase
        .storage
        .from('disenos')
        .getPublicUrl(filePath);
      
      designUrl = urlData.publicUrl;
    }

    // 3. Guardar el pedido en la base de datos de Supabase
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
        design_url: designUrl, // Acá guardamos el link del archivo
        status: 'pending',
        created_at: new Date().toISOString()
      }])
      .select()
      .single();
    
    if (dbError) {
      console.error('Error guardando pedido en BD:', dbError);
      return res.status(500).json({ error: 'Error al guardar el pedido' });
    }

    // 4. Crear la preferencia de pago en Mercado Pago
    const preference = {
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

    const mpResponse = await mercadopago.preferences.create(preference);
    const mpData = mpResponse.body;

    if (!mpData.init_point) {
      return res.status(500).json({ error: 'Error creando preferencia de pago' });
    }

    // 5. Actualizar el pedido con el link de pago de MP
    await supabase
      .from('orders')
      .update({ payment_url: mpData.init_point })
      .eq('id', order.id);

    // 6. Enviar el link al frontend
    res.json({
      success: true,
      init_point: mpData.init_point,
      orderId: order.id
    });

  } catch (error) {
    console.error('Error general en /api/orders:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// RUTA WEBHOOK (para que MP te avise cuando pagan)
app.post('/api/webhook', express.json(), async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type === 'payment') {
      const paymentId = data.id;
      const paymentInfo = await mercadopago.payment.findById(paymentId);
      const status = paymentInfo.body.status;

      if (status === 'approved') {
        // Buscar el pedido por el external_reference o metadata (si lo configuraste)
        // Por ahora, un log simple para que veas que llega:
        console.log(`Pago aprobado! ID: ${paymentId}`);
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).send('Error');
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});